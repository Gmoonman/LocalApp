import { processExists } from "./helpers/processExists.js";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import { AgentSettingsStore } from "@localapp/dsh-multiuser/settings";
import { registerAgentRoutes } from "@localapp/dsh-multiuser/agent-routes";
import { DeepSeekHarness } from "../deepseek-harness.mjs";
import { expect, it, vi } from "vitest";

it.each(["application", "capabilities", "grants", "python", "provider", "mcp", "tools"] as const)("terminates a real background process when %s access is revoked", async reason => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/background-access-stop");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "data-"));
  const values = new Map<string, string>();
  const settings = new AgentSettingsStore(root, { users: () => [...values.keys()], read: id => values.get(id), write: (id, value) => { values.set(id, value); } }, []);
  settings.write("alice", { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: "http://model.test/v1", model: "own", apiKey: "own" }], defaultProviderId: "own", grants: { "alice/scheduled": ["terminal", "jobs"] }, mcpServers: [] });
  const requests: any[] = [];
  const initialSettings = settings.read("alice");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const hasResult = request.messages.some((message: any) => message.role === "tool");
    const delta = hasResult ? { content: "Background started" } : { tool_calls: [{ index: 0, id: "access-background", function: { name: "bash", arguments: JSON.stringify({ description: "Access background process", command: `exec node -e 'require("fs").writeFileSync("job.pid", String(process.pid)); setInterval(() => {}, 1000)'`, run_in_background: true }) } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  let available = true;
  let capabilitiesAllowed = true;
  let workspaceRoot = "";
  const context = new Context(), app = Fastify();
  try {
    await context.plugin(Multiuser);
    await registerAgentRoutes(app, {
      dataDir: root, settings, runtimes: context.localappMultiuser,
      userId: () => "alice", isAuthenticated: () => true,
      resolveApp: (_user, appId) => { if (!available) throw new Error("Application unavailable"); return { id: appId ?? "platform", capabilities: capabilitiesAllowed ? ["terminal", "jobs"] : [] }; },
      environment: async () => ({ checks: [] }) as any,
      clientAssets: async () => { throw new Error("Unused"); },
      createHarness: config => { if (!config.root) throw new Error("Missing test workspace root"); workspaceRoot = path.join(config.root, "workspace"); return new DeepSeekHarness({ ...config, autoSessionTitles: false }); },
    });
    const run = await app.inject({ method: "POST", url: "/api/agent/run", payload: { appId: "alice/scheduled", sessionId: "scheduled-session", prompt: "Create reminder", systemPrompt: "", tools: [] } });
    expect(run.statusCode).toBe(200);
    expect(run.body).toContain("Background started");
    let pid = 0;
    await expect.poll(async () => {
      try { pid = Number(await fs.readFile(path.join(workspaceRoot, "job.pid"), "utf8")); return pid > 0; }
      catch { return false; }
    }, { timeout: 5000 }).toBe(true);
    expect(processExists(pid)).toBe(true);
    // Allow the periodic check to run after /run records the application's tool catalog.
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(context.localappMultiuser.forUser("alice")).toHaveLength(1);
    expect(processExists(pid)).toBe(true);
    if (reason === "application") available = false;
    else if (reason === "capabilities") capabilitiesAllowed = false;
    else if (reason === "python") await fs.writeFile(path.join(root, "python-environment.json"), JSON.stringify({ executable: path.join(root, "python", "bin", "python"), directory: path.join(root, "python"), baseDirectory: path.join(root, "base-python"), revision: "new-environment", managed: true, version: "3.12.0" }));
    else if (reason === "provider") settings.write("alice", { ...settings.read("alice"), providers: [{ ...initialSettings.providers[0], apiKey: "replacement-key" }] });
    else if (reason === "mcp") settings.write("alice", { ...settings.read("alice"), mcpServers: [{ serverName: "changed", transport: "stdio", command: "node" }] });
    else if (reason === "tools") settings.write("alice", { ...settings.read("alice"), applications: { "alice/scheduled": { skills: [], tools: [], disabledTools: ["bash"] } } });
    else settings.write("alice", { ...settings.read("alice"), grants: {} });
    await expect.poll(() => context.localappMultiuser.forUser("alice").length, { timeout: 5000 }).toBe(0);
    await expect.poll(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }, { timeout: 5000 }).toBe(true);
    available = true;
    if (reason === "python") await fs.rm(path.join(root, "python-environment.json"));
    if (["provider", "mcp", "tools"].includes(reason)) settings.write("alice", initialSettings);
    await expect.poll(async () => {
      const history = await app.inject("/api/agent/sessions/scheduled-session?appId=alice/scheduled");
      expect(history.statusCode, history.body).toBe(200);
      expect(history.body).toContain("Access background process");
      return true;
    }, { timeout: 3000 }).toBe(true);
  } finally { await app.close(); await context.fiber.dispose(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);
