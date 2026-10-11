import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import DocumentTools from "@localapp/dsh-document-tools";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-multiuser/settings";
import { registerAgentRoutes } from "@localapp/dsh-multiuser/agent-routes";
import { DeepSeekHarness } from "../deepseek-harness.mjs";
import { expect, it, vi } from "vitest";

it.each(["documents", "application", "capabilities", "grants"] as const)("stopping %s access aborts its real dsh turn while an ordinary turn keeps running", async reason => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/document-stream-stop");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, ["pdf"]);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: { platform: ["skills"] }, applications: { platform: { skills: ["pdf"], disabledTools: [], tools: [] } }, mcpServers: [] });
  let applicationAvailable = true;
  let skillsAllowed = true;
  const opened = new Set<string>(), aborted = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    const label = JSON.stringify(request.messages).includes("Document stream marker") ? "document" : "ordinary";
    opened.add(label);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" }, finish_reason: null }] })}\n\n`));
      init.signal.addEventListener("abort", () => { aborted.add(label); controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }));
  const context = new Context(), app = Fastify();
  const runs: Array<Promise<{ statusCode: number }>> = [];
  try {
    const documents = await context.plugin(DocumentTools);
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser, documents: () => context.get("localappDocuments"),
      userId: () => "alice", isAuthenticated: () => true, resolveApp: (_user, appId) => {
        if ((!appId || appId === "platform") && !applicationAvailable) throw new Error("Application unavailable");
        return { id: appId ?? "platform", capabilities: appId === "alice/ordinary" || skillsAllowed ? ["skills"] : [] };
      },
      environment: async () => ({ checks: ["runner", "python", "pypdf", "pdfplumber", "reportlab"].map(id => ({ id, status: "ready" })) }) as any,
      clientAssets: async () => { throw new Error("Unused"); },
      createHarness: config => new DeepSeekHarness({ ...config, autoSessionTitles: false }),
    });
    for (const [appId, sessionId, prompt] of [["platform", "document-stream", "Document stream marker"], ["alice/ordinary", "ordinary-stream", "Ordinary stream marker"]]) {
      runs.push(app.inject({ method: "POST", url: "/api/agent/run", payload: { appId, sessionId, prompt, systemPrompt: "", tools: [] } }));
    }
    await expect.poll(() => opened.size, { timeout: 5000 }).toBe(2);
    if (reason === "documents") await documents.dispose();
    else {
      if (reason === "application") applicationAvailable = false;
      else if (reason === "capabilities") skillsAllowed = false;
      else settings.write("alice", { ...settings.read("alice"), grants: {} });
      await expect.poll(() => aborted.has("document"), { timeout: 3000 }).toBe(true);
    }
    expect(aborted).toEqual(new Set(["document"]));
    expect((await runs[0]).statusCode).toBe(200);
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(1);
    applicationAvailable = true;
    let history = await app.inject("/api/agent/sessions/document-stream");
    // The run response can end before asynchronous runtime invalidation finishes.
    await expect.poll(async () => {
      history = await app.inject("/api/agent/sessions/document-stream");
      return history.statusCode;
    }, { timeout: 3000 }).toBe(200);
    expect(history.body).toContain("Document stream marker");
    const workspace = path.join(root, "agent", createHash("sha256").update(JSON.stringify(["alice", "platform", "own"])).digest("hex"), "workspace", ".localapp-public-skills");
    if (reason === "documents") expect(await fs.readdir(workspace)).toEqual([]);
    else if (reason === "application") expect(await fs.readdir(workspace)).toContain("pdf");
    else expect(await fs.readdir(workspace)).toEqual([]);
    expect(aborted).toEqual(new Set(["document"]));
    const cancelled = await app.inject({ method: "POST", url: "/api/agent/cancel", payload: { appId: "alice/ordinary", sessionId: "ordinary-stream" } });
    expect(cancelled.json().success).toBe(true);
    await runs[1];
    expect(aborted).toEqual(new Set(["document", "ordinary"]));
  } finally {
    await context.localappMultiuser?.close(); await Promise.allSettled(runs);
    await app.close(); await context.fiber.dispose(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true });
  }
});
