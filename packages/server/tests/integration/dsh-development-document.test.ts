import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { findUserByName, closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";
import { selectPythonEnvironment, shellQuote } from "../../src/lib/python-environment.js";

it.skipIf(!process.env.LOCALAPP_DEVELOPER_DOCUMENT_PYTHON).each(["docx", "pdf", "xlsx"])("reads an uploaded %s using the selected developer Skill and records its result", async format => {
  const python = process.env.LOCALAPP_DEVELOPER_DOCUMENT_PYTHON!;
  const parent = path.resolve(__dirname, "../../../../tmp/developer-document");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const fixture = path.join(root, "input." + format);
  const marker = "developer-" + format + "-real-marker";
  const mimeTypes: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const generators: Record<string, string> = {
    docx: "from docx import Document; import sys; d=Document(); d.add_paragraph(sys.argv[2]); d.save(sys.argv[1])",
    pdf: "from reportlab.pdfgen import canvas; import sys; c=canvas.Canvas(sys.argv[1]); c.drawString(72,720,sys.argv[2]); c.save()",
    xlsx: "from openpyxl import Workbook; import sys; w=Workbook(); w.active.append(['Name', 'Value']); w.active.append([sys.argv[2], 42]); w.save(sys.argv[1])",
  };
  await promisify(execFile)(python, ["-c", generators[format], fixture, marker]);
  await selectPythonEnvironment(root, python);
  let command = "";
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    const call = request.tools && request.messages.at(-1)?.role !== "tool";
    const delta = call ? { tool_calls: [{ index: 0, id: "read-document", function: { name: "bash", arguments: JSON.stringify({ command, description: "Read the uploaded document using the selected public Skill" }) } }] } : { content: "Document read" };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const tokens = new SetupTokenStore();
  const app = await buildServer({ setupTokens: tokens, pluginCombination: "full", env: { DATA_DIR: root, BOOTSTRAP_API_KEY: "document-key", JWT_SECRET: "document-secret" } });
  const headers = { "X-API-Key": "document-key" };
  try {
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: tokens.issue().token, username: "document-owner", password: "document-owner-password" } })).statusCode).toBe(201);
    new AgentSettingsStore(root).write(findUserByName("document-owner")!.id, { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "document-model", apiKey: "own" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    const project = await app.inject({ method: "POST", url: "/api/development/projects", headers, payload: { name: "document-app" } });
    expect(project.statusCode, project.body).toBe(201);
    const id = project.json().data.id;
    const setting = await app.inject({ method: "PUT", url: `/api/development/projects/${id}/agent/settings`, headers, payload: { enabledCapabilities: ["files", "skills", "terminal"], enabledSkills: [format], disabledTools: [] } });
    expect(setting.statusCode, setting.body).toBe(200);
    const boundary = "developer-document-boundary";
    const upload = await app.inject({ method: "POST", url: `/api/development/projects/${id}/attachments`, headers: { ...headers, "content-type": "multipart/form-data; boundary=" + boundary }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="input.${format}"\r\nContent-Type: ${mimeTypes[format]}\r\n\r\n`), await fs.readFile(fixture), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    expect(upload.statusCode, upload.body).toBe(200);
    const attachment = upload.json().data;
    command = `${shellQuote(python)} .localapp-public-skills/${format}/scripts/${format}_read.py ${shellQuote(attachment.path)} ${format === "xlsx" ? "--json" : "--text"}`;
    const run = await app.inject({ method: "POST", url: `/api/development/projects/${id}/agent/run`, headers, payload: { sessionId: "document-session", prompt: "Read the attached document", attachmentIds: [attachment.id] } });
    expect(run.statusCode, run.body).toBe(200);
    const initial = requests.find(request => request.tools);
    expect(initial.model).toBe("document-model");
    expect(JSON.stringify(initial.messages)).toContain(attachment.path);
    expect(JSON.stringify(initial.messages)).not.toContain(marker);
    expect(await fs.readdir(path.join(root, "development", "projects", id, "workspace", ".localapp-public-skills"))).toEqual([format]);
    expect(JSON.stringify(requests.flatMap(request => request.messages.filter((message: any) => message.role === "tool")))).toContain(marker);
    const native = async (method: string, args: any) => {
      const response = await app.inject({ method: "POST", url: `/api/development/projects/${id}/native/own/api/session/${method}`, headers, payload: { type: "client-request", rpcId: method, method: "session/" + method, payload: { args } } });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().result.ok, response.body).toBe(true);
      return response.json().result.value;
    };
    const projection = await native("projections", { request: { sessionId: "document-session" } });
    const page = await native("page", { request: { address: { kind: "session", sessionId: "document-session" }, throughSeq: projection.asOfSeq } });
    expect(JSON.stringify(page.records)).toContain(marker);
    expect(page.records.some((record: any) => record.type === "event" && record.event.type === "tool/call" && record.event.data.name === "bash")).toBe(true);
  } finally { await app.close(); closeMetaDb(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
