import http from "node:http";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { SetupTokenStore } from "../../src/lib/setup-token-store.js";
import { closeMetaDb, createApiKey, createUser, findUserByName, getDb, flushMetaDb } from "../../src/lib/meta-sqlite.js";
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tmp/deepseek-test-harness-http-e2e", String(process.pid));
const adminKey = "test-harness-e2e-admin-key";
const testCombination = process.env.LOCALAPP_NATIVE_TEST_COMBINATION ?? "full";
if (testCombination !== "full" && testCombination !== "platform" && testCombination !== "multiuser") throw new Error("Unsupported native test combination");
describe("unified Server DeepSeek Harness HTTP", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let model: http.Server;
  let baseUrl: string;
  let outsiderKey: string;
  let developerSessionId:string;
  const modelRequests: any[] = [];
  let cancelledModelStreams = 0;
  beforeAll(async () => {
    model = http.createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      modelRequests.push({ ...request, authorization: req.headers.authorization });
      const lastUser = request.messages.filter((message: any) => message.role === "user" && !String(message.content).startsWith("Current runtime context.") && !String(message.content).startsWith("<system-reminder>")).at(-1);
      if (lastUser?.content === "native cancellable stream") {
        res.writeHead(200,{"Content-Type":"text/event-stream"});
        res.write(`data: ${JSON.stringify({choices:[{delta:{content:"working"},finish_reason:null}]})}\n\n`);
        res.once("close",()=>cancelledModelStreams++);
        return;
      }
      const hasResult = request.messages.at(-1)?.role === "tool";
      if (request.messages.some((message: any) => message.content === "standalone native read")) {
        const delta = hasResult ? { content: "Standalone browser completed" } : { tool_calls: [{ index: 0, id: "standalone-browser-read", function: { name: "read", arguments: JSON.stringify({ file_path: "private.txt" }) } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (request.messages.some((message: any) => message.content === "native background command")) {
        const finished = request.messages.some((message: any) => message.role === "tool");
        const delta = finished ? { content: "native background started" } : { tool_calls: [{ index: 0, id: "native-background", function: { name: "bash", arguments: JSON.stringify({ description: "Native background command", command: "printf native-background-output; sleep 120", run_in_background: true }) } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (request.messages.some((message: any) => message.content === "native schedule create")) {
        const delta = hasResult ? { content: "native schedule created" } : { tool_calls: [{ index: 0, id: "native-schedule", function: { name: "schedule_create", arguments: JSON.stringify({ title: "Native schedule marker", prompt: "scheduled application work", after_seconds: 3600 }) } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if(lastUser?.content==="native developer question"){
        const delta=hasResult?{content:"native question finished"}:{tool_calls:[{index:0,id:"native-question",function:{name:"ask_user_question",arguments:JSON.stringify({questions:[{id:"color",question:"选择应用颜色",options:[{label:"蓝色",description:"使用蓝色"},{label:"绿色",description:"使用绿色"}]}]})}}]};
        res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:hasResult?"stop":"tool_calls"}]})}\n\ndata: [DONE]\n\n`);return;
      }
      if (["native creation plan", "native creation browser plan"].includes(lastUser?.content)) {
        const delta = hasResult ? { content: "native creation proposed" } : { tool_calls: [{ index: 0, id: "creation-proposal", function: { name: "propose_application", arguments: JSON.stringify({ name: lastUser.content === "native creation browser plan" ? "native-browser-created-app" : "native-created-app", description: "Create an application through native dsh" }) } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const lastUserText = Array.isArray(lastUser?.content) ? lastUser.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("") : lastUser?.content;
      if (lastUserText === "native broken preview edit" || String(lastUserText).startsWith("平台预览编译失败（自动修复")) {
        const repair = lastUserText !== "native broken preview edit";
        const id = repair ? "native-preview-repair" : "native-preview-break";
        const finished = request.messages.at(-1)?.tool_call_id === id;
        const command = repair
          ? `node -e 'const fs=require("node:fs");const p="src/App.tsx";fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("const localappBrokenPreview = ;","// Native preview repaired"))'`
          : `node -e 'require("node:fs").appendFileSync("src/App.tsx","\\nconst localappBrokenPreview = ;\\n")'`;
        const delta = finished ? { content: repair ? "native preview repaired" : "native preview broken" }
          : { tool_calls: [{ index: 0, id, function: { name: "bash", arguments: JSON.stringify({ description: repair ? "Repair compiler failure" : "Create a compiler failure", command }) } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if(lastUserText==="native formal application edit"){
        const edited=request.messages.at(-1)?.tool_call_id==="formal-edit";
        const command=`node -e 'const fs=require("node:fs");const p="src/App.tsx";fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("工作项</h1>","Native edited application</h1>"))'`;
        const delta=edited?{content:"native formal application edited"}:{tool_calls:[{index:0,id:"formal-edit",function:{name:"bash",arguments:JSON.stringify({description:"Edit the application heading",command})}}]};
        res.writeHead(200,{"Content-Type":"text/event-stream"});
        res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:edited?"stop":"tool_calls"}]})}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (lastUserText === "native creation edit" || String(lastUserText).startsWith("用户已确认创建应用")) {
        const edited = request.messages.at(-1)?.tool_call_id === "creation-edit";
        const delta = edited ? { content: "native application edited" } : !hasResult ? { tool_calls: [{ index: 0, id: "creation-read", function: { name: "read", arguments: JSON.stringify({ file_path: "index.html" }) } }] } : { tool_calls: [{ index: 0, id: "creation-edit", function: { name: "write", arguments: JSON.stringify({ file_path: "index.html", content: '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Native edited application</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' }) } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: edited ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const native = request.messages.some((message: any) => message.content === "native HTTP hello");
      const developer = request.messages.some((message: any) => message.content === "native developer read");
      if (developer) {
        const delta = hasResult ? { content: "native developer finished" } : { tool_calls: [{ index: 0, id: "dev-read", function: { name: "read", arguments: '{"file_path":"manifest.json"}' } }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (!hasResult) res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "native developer reasoning: inspect the application manifest" }, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const completed = hasResult || native;
      const delta = completed ? { content: native ? "native HTTP finished" : "工具已完成" } : { tool_calls: [{ index: 0, id: "http-call", function: { name: "echo", arguments: '{"text":"hello"}' } }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const tokens = new SetupTokenStore();
    const { buildNativeClient } = await import("../../scripts/build-native-client.mjs");
    const nativeClientRoot = path.join(dataDir, "native-client");
    await buildNativeClient(nativeClientRoot);
    app = await buildServer({ pluginCombination: testCombination, nativeClientRoot, setupTokens: tokens, env: { DATA_DIR: dataDir, JWT_SECRET: "test-harness-http-e2e", BOOTSTRAP_API_KEY: adminKey, LLM_API_KEY: "mock-key", LLM_BASE_URL: `http://127.0.0.1:${(model.address() as any).port}/v1`, LLM_MODEL: "mock-model" } });
    const token = tokens.issue();
    expect((await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { token: token.token, username: "harness-http-admin", password: "harness-test-password" } })).statusCode).toBe(201);
    const bcrypt = await import("bcryptjs");
    createUser("harness-outsider", "harness-outsider", await bcrypt.hash("ordinary-browser-password", 10));
    outsiderKey = createApiKey("harness-outsider").key;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { providers: [{ id: "mock", name: "Mock", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "mock-model", apiKey: "mock-key" }], defaultProviderId: "mock", grants: {}, mcpServers: [] } })).statusCode).toBe(200);
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${app.addresses()[0].port}`;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => model?.close(() => resolve()));
    closeMetaDb();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  it.runIf(testCombination === "multiuser" && process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("uses standalone settings and native workspace conversation without application plugins", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const workspace = path.join(dataDir, "agent", createHash("sha256").update(JSON.stringify([owner.id, "platform", "mock"])).digest("hex"), "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "private.txt"), "Standalone browser private file");
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      expect((await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-http-admin", password: "harness-test-password" } })).status()).toBe(200);
      await page.goto(baseUrl + "/my/models");
      await page.getByRole("heading", { name: "工作区 Agent 设置", exact: true }).waitFor();
      const protocol = page.getByRole("combobox", { name: "供应商接口协议 1", exact: true });
      await protocol.click();
      await page.getByRole("option", { name: "OpenAI Responses", exact: true }).waitFor();
      const modelEvidence = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(modelEvidence, { recursive: true });
      await page.screenshot({ path: path.join(modelEvidence, "multiuser-model-protocol-menu.png") });
      await page.keyboard.press("Escape");
      expect(await protocol.evaluate(element => element === document.activeElement)).toBe(true);
      await protocol.click();
      await page.getByRole("option", { name: "OpenAI Responses", exact: true }).click();
      expect(await protocol.innerText()).toBe("OpenAI Responses");
      await protocol.click();
      await page.getByRole("option", { name: "OpenAI Chat Completions / DeepSeek / 兼容接口", exact: true }).click();
      await page.getByRole("button", { name: "添加 MCP 服务", exact: true }).click();
      const transport = page.getByRole("combobox", { name: "MCP 连接方式 1", exact: true });
      await transport.click();
      await page.getByRole("option", { name: "本机 stdio（在应用工作区运行）", exact: true }).click();
      await page.getByLabel("MCP 命令 1", { exact: true }).waitFor();
      await page.getByRole("button", { name: "删除 MCP 1", exact: true }).click();
      await page.getByRole("button", { name: "保存模型与 Agent 设置", exact: true }).click();
      await page.getByText("模型与 Agent 设置已保存", { exact: true }).waitFor();
      const fileSwitch = page.getByRole("switch", { name: "工作区文件", exact: true });
      await fileSwitch.click();
      await page.getByRole("button", { name: "保存 Agent 设置", exact: true }).click();
      await page.getByText("Agent 设置已保存", { exact: true }).waitFor();
      const saved = await page.request.get(baseUrl + "/api/agent/app-settings?appId=platform");
      expect((await saved.json()).data.enabledCapabilities).toEqual(["files"]);
      await page.reload(); await fileSwitch.waitFor(); expect(await fileSwitch.getAttribute("aria-checked")).toBe("true");
      await page.getByRole("heading", { name: "工作区 Agent 设置", exact: true }).scrollIntoViewIfNeeded();
      const settingsEvidence = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(settingsEvidence, { recursive: true });
      await page.screenshot({ path: path.join(settingsEvidence, "standalone-workspace-settings.png"), fullPage: true });
      await page.getByRole("button", { name: "打开工作区对话", exact: true }).click();
      await page.waitForURL("**/api/agent/native/**/");
      const nativeSettings = page.getByRole("button", { name: /^(设置|Settings)$/ });
      await nativeSettings.click();
      await page.getByRole("button", {name: "Python 环境", exact: true}).click();
      await page.getByLabel("虚拟环境 Python 路径", {exact: true}).waitFor();
      await page.getByRole("button", {name: "创建专用虚拟环境", exact: true}).click();
      await page.getByLabel("基础 Python 路径（3.10+）", {exact: true}).waitFor();
      expect(await page.getByRole("switch", {name: "同时安装公共文档 Skills 依赖", exact: true}).getAttribute("aria-checked")).toBe("false");
      await page.getByRole("button", {name: "使用已有虚拟环境", exact: true}).click();
      await page.getByText(/Server 系统：/).waitFor();
      await page.getByRole("button", {name: "重新检查", exact: true}).click();
      await page.getByText(/Server 系统：/).waitFor();
      await page.screenshot({path: path.join(settingsEvidence, "native-python-environment.png")});
      await page.getByRole("button", { name: "模型与 MCP", exact: true }).click();
      const nativeProtocol = page.getByRole("combobox", {name: "供应商接口协议 1", exact: true});
      await nativeProtocol.click();
      await page.getByRole("option", {name: "OpenAI Responses", exact: true}).waitFor();
      expect(await page.getByRole("option", {name: "OpenAI Responses", exact: true}).evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return hit === element || element.contains(hit);
      })).toBe(true);
      await page.screenshot({path: path.join(settingsEvidence, "native-model-protocol-menu.png")});
      await page.keyboard.press("Escape");
      await expect.poll(() => nativeProtocol.evaluate(element => element === document.activeElement)).toBe(true);
      await nativeProtocol.click();
      await page.getByRole("option", {name: "OpenAI Responses", exact: true}).click();
      await nativeProtocol.click();
      await page.getByRole("option", {name: "OpenAI Chat Completions / DeepSeek / 兼容接口", exact: true}).click();
      await page.getByRole("button", {name: "添加 MCP 服务", exact: true}).click();
      await page.getByRole("combobox", {name: "MCP 连接方式 1", exact: true}).click();
      await page.getByRole("option", {name: "本机 stdio（在应用工作区运行）", exact: true}).click();
      await page.getByLabel("MCP 命令 1", {exact: true}).waitFor();
      await page.getByRole("button", {name: "删除 MCP 1", exact: true}).click();
      await page.getByRole("button", {name: "保存模型与 Agent 设置", exact: true}).click();
      await page.getByText("模型与 Agent 设置已保存", {exact: true}).waitFor();
      const nativeModels = (await (await page.request.get(baseUrl + "/api/agent/settings")).json()).data;
      expect(nativeModels.providers[0].hasApiKey).toBe(true);
      expect(nativeModels.providers[0].apiKey).toBeUndefined();
      await page.getByRole("button", { name: "Agent 能力", exact: true }).click();
      const nativeCapabilityPanel = page.locator(".localapp-native-settings");
      await nativeCapabilityPanel.getByRole("switch", { name: "工作区文件", exact: true }).waitFor();
      expect(await nativeCapabilityPanel.getByRole("switch", { name: "工作区文件", exact: true }).getAttribute("aria-checked")).toBe("true");
      const nativeTerminal = nativeCapabilityPanel.getByRole("switch", { name: "终端执行", exact: true });
      await nativeTerminal.click();
      await nativeCapabilityPanel.getByRole("button", { name: "保存 Agent 设置", exact: true }).click();
      await nativeCapabilityPanel.getByText("Agent 设置已保存", { exact: true }).waitFor();
      const nativeSaved = await page.request.get(baseUrl + "/api/agent/app-settings?appId=platform");
      expect((await nativeSaved.json()).data.enabledCapabilities).toEqual(["files", "terminal"]);
      await page.screenshot({path: path.join(settingsEvidence, "native-capability-settings.png")});
      await page.keyboard.press("Escape");
      await nativeCapabilityPanel.waitFor({state: "hidden"});
      await expect.poll(() => nativeSettings.evaluate(element => element === document.activeElement)).toBe(true);
      const input = page.locator("textarea, [contenteditable=true]").first();
      await input.fill("standalone native read"); await input.press("Enter");
      await page.getByText("Standalone browser completed", { exact: true }).first().waitFor({ timeout: 15000 });
      await page.getByText("轨迹", { exact: true }).click();
      await page.getByText("Standalone browser private file", { exact: false }).first().waitFor();
      expect(modelRequests.at(-1).authorization).toBe("Bearer mock-key");
      expect(errors).toEqual([]);
      expect((await app.inject("/api/development/creations")).statusCode).toBe(404);
      expect((await app.inject("/api/pages")).statusCode).toBe(404);
      const evidence = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, "standalone-native-workspace.png"), fullPage: true });
    } finally { await browser.close(); }
  }, 30000);

  it("requires authentication and validates input", async () => {
    const send = (key?: string) => fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}) }, body: "{}" });
    expect((await send()).status).toBe(401);
    expect((await send(adminKey)).status).toBe(400);
  });
  it("streams a harness turn and accepts tool results only from the owning user", async () => {
    const response = await fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "http-e2e-session", prompt: "echo hello", systemPrompt: "Use echo", tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }) });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: any[] = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5)); events.push(event);
        if (event.type !== "tool_call") continue;
        const submit = (key: string) => fetch(`${baseUrl}/api/agent/tool-result`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ token: event.token, result: { echo: event.args.text } }) });
        expect((await submit(outsiderKey)).status).toBe(404);
        expect((await submit(adminKey)).status).toBe(200);
        expect((await submit(adminKey)).status).toBe(404);
      }
    }
    expect(events.some((e) => e.type === "text_delta" && e.text === "工具已完成")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1).type).toBe("done");
  });
  it("serves native session history with Server authentication and application access", async () => {
    const send = (key?: string, appId = "platform", origin?: string) => fetch(
      baseUrl + "/api/agent/native/api/session/list?appId=" + encodeURIComponent(appId), {
        method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ type: "client-request", rpcId: "native-list", method: "session/list", payload: { args: { _request: {} } } }),
      });
    expect((await send()).status).toBe(401);
    const own = await send(adminKey); expect(own.status).toBe(200);
    expect(await own.text()).toContain("http-e2e-session");
    const page = await fetch(baseUrl + "/api/agent/native/api/session/page", {
      method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "native-page", method: "session/page", payload: { args: { request: { address: { kind: "session", sessionId: "http-e2e-session" }, throughSeq: 0 } } } }),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("echo hello");
    const workspace = await fetch(baseUrl + "/api/agent/native/api/workspace/initializeDefault", {
      method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "native-workspace", method: "workspace/initializeDefault", payload: { args: {} } }),
    });
    expect(workspace.status).toBe(200);
    expect((await workspace.json()).result.value.workspace.path.startsWith(path.join(dataDir, "agent"))).toBe(true);
    expect((await send(adminKey, "missing/application")).status).toBe(400);
    expect((await send(adminKey, "platform", "https://untrusted.test")).status).toBe(403);
    expect((await send(outsiderKey)).status).toBe(400);
  });
  it("exposes the configured model through native session RPC", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (method: string, args: unknown, key = adminKey) => fetch(`${baseUrl}/api/agent/native/${scope}/api/session/${method}`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `native-${method}`, method: `session/${method}`, payload: { args } }),
    });
    const catalog = await send("modelCatalog", {});
    expect(catalog.status).toBe(200);
    const value = (await catalog.json()).result.value;
    expect(value.groups).toEqual([{ id: "localapp", name: "localapp", models: [{ id: "mock-model", name: "mock-model" }] }]);
    expect(value.failures).toEqual([]);
    const selection = await send("selectModel", { request: { sessionId: "http-e2e-session", provider: "localapp", model: "mock-model" } });
    expect(selection.status).toBe(200);
    expect((await selection.json()).result.value.selected).toMatchObject({ provider: "localapp", model: "mock-model" });
    const foreign = await send("selectModel", { request: { sessionId: "http-e2e-session", provider: "other", model: "mock-model" } });
    expect(await foreign.text()).toContain("session/model-unavailable");
    expect((await send("modelCatalog", {}, outsiderKey)).status).toBe(400);
  });
  it("creates native sessions over authenticated scoped HTTP", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (request: unknown, key = adminKey) => fetch(`${baseUrl}/api/agent/native/${scope}/api/session/create`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "native-create", method: "session/create", payload: { args: { request } } }),
    });
    const created = await send({});
    expect(created.status).toBe(200);
    expect((await created.json()).result.value.sessionId).toMatch(/^session-/);
    expect(await (await send({ sessionId: "../escape" })).text()).toContain("Invalid session ID");
    expect(await (await send({ cwd: dataDir })).text()).toContain("outside the application workspace");
    expect((await send({}, outsiderKey)).status).toBe(400);
  });
  it("executes native HTTP prompts and keeps their original trajectory", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (method: string, args: unknown, key = adminKey) => fetch(`${baseUrl}/api/agent/native/${scope}/api/session/${method}`, {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `native-${method}`, method: `session/${method}`, payload: { args } }),
    });
    const { sessionId } = (await (await send("create", { request: {} })).json()).result.value;
    const request = { sessionId, requestId: "native-http-request", mode: "queue", content: [{ type: "text", text: "native HTTP hello" }] };
    const promptRequests = () => modelRequests.filter(item => item.messages.some((message: any) => message.content === "native HTTP hello"));
    const response = await send("prompt", { request });
    expect(response.status).toBe(200);
    expect((await response.json()).result.value).toEqual({ accepted: true });
    const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/agent/native/${scope}/api/remote.mux`, { headers: { "X-API-Key": adminKey } });
    try {
      const trajectory = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native prompt trajectory timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", frame => {
          const text = frame.toString();
          if (text.includes("native HTTP finished")) { clearTimeout(timer); resolve(text); }
        });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "prompt-trajectory", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
      });
      expect(trajectory).toContain("native HTTP finished");
    } finally { socket.terminate(); }
    expect(promptRequests()).toHaveLength(1);
    expect(promptRequests()[0]).toMatchObject({ model: "mock-model", authorization: "Bearer mock-key" });
    expect((await send("prompt", { request })).status).toBe(200);
    expect(promptRequests()).toHaveLength(1);
    expect((await send("prompt", { request }, outsiderKey)).status).toBe(400);
  });
  it("plans and creates an application through native dsh while retaining the same session", async () => {
    const draft = (await (await fetch(baseUrl + "/api/development/creations", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "mock" }) })).json()).data;
    const prefix = `/api/development/projects/${draft.projectId}/native/mock/api`;
    const send = (method: string, args: unknown) => fetch(baseUrl + prefix + "/session/" + method, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "creation-" + method, method: "session/" + method, payload: { args } }) });
    expect((await (await send("create", { request: { sessionId: draft.sessionId } })).json()).result.value.sessionId).toBe(draft.sessionId);
    expect((await (await send("prompt", { request: { sessionId: draft.sessionId, requestId: "creation-plan", mode: "queue", content: [{ type: "text", text: "native creation plan" }] } })).json()).result.value.accepted).toBe(true);
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + prefix + "/remote.mux", { headers: { "X-API-Key": adminKey } });
    let throughSeq = 0;
    const frames: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native creation timed out: " + frames.join("\n"))), 10000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", frame => {
          const text = frame.toString();
          frames.push(text);
          for (const match of text.matchAll(/"seq":(\d+)/g)) throughSeq = Math.max(throughSeq, Number(match[1]));
          if (text.includes("native creation proposed")) { clearTimeout(timer); resolve(); }
        });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "creation", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: draft.sessionId } } } } })));
      });
    } finally { socket.terminate(); }
    const proposal = (await (await fetch(baseUrl + `/api/development/creations/${draft.projectId}`, { headers: { "X-API-Key": adminKey } })).json()).data;
    expect(proposal.proposal.name).toBe("native-created-app");
    const confirmed = await fetch(baseUrl + `/api/development/creations/${draft.projectId}/confirm`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ name: proposal.proposal.name }) });
    expect(confirmed.status).toBe(200);
    const ready = (await confirmed.json()).data;
    expect(ready.state).toBe("ready");
    expect(ready.sessionId).toBe(draft.sessionId);
    expect((await fetch(baseUrl + ready.url, { headers: { "X-API-Key": adminKey } })).status).toBe(200);
    const history = await send("page", { request: { address: { kind: "session", sessionId: draft.sessionId }, throughSeq } });
    const wire = await history.text();
    expect(wire).toContain("native creation plan");
    expect(wire).toContain("propose_application");
    expect(wire).toContain("native creation proposed");
    const continueCreation=()=>fetch(baseUrl+`/api/development/creations/${draft.projectId}/continue`,{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:"{}"});
    const {ApplicationCreations}=await import("@localapp/dsh-app-development/creation");
    const failedSave=vi.spyOn(ApplicationCreations.prototype,"continue").mockImplementationOnce(()=>{throw new Error("Test continuation state save failed");});
    try{const rejected=await continueCreation();expect(rejected.status).toBe(400);expect(await rejected.text()).toContain("Test continuation state save failed");}finally{failedSave.mockRestore();}
    expect((await (await fetch(baseUrl+`/api/development/creations/${draft.projectId}`,{headers:{"X-API-Key":adminKey}})).json()).data.continued).not.toBe(true);
    await expect.poll(async()=>{
      const builds=(await (await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/builds`,{headers:{"X-API-Key":adminKey}})).json()).data;
      return builds.find((build:any)=>build.purpose==="preview")?.status;
    },{timeout:30000}).toBe("succeeded");
    await app.close();closeMetaDb();
    app=await buildServer({pluginCombination:testCombination,nativeClientRoot:path.join(dataDir,"native-client"),env:{DATA_DIR:dataDir,JWT_SECRET:"test-harness-http-e2e",BOOTSTRAP_API_KEY:adminKey,LLM_API_KEY:"mock-key",LLM_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}/v1`,LLM_MODEL:"mock-model"}});
    await app.listen({host:"127.0.0.1",port:0});baseUrl=`http://127.0.0.1:${app.addresses()[0].port}`;
    const continuations=await Promise.all([continueCreation(),continueCreation()]);
    for(const response of continuations){expect(response.status).toBe(200);expect((await response.json()).data.accepted).toBe(true);}
    expect((await (await fetch(baseUrl+`/api/development/creations/${draft.projectId}`,{headers:{"X-API-Key":adminKey}})).json()).data.continued).toBe(true);
    await expect.poll(async () => {
      const response = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/builds`, { headers: { "X-API-Key": adminKey } });
      return (await response.json()).data.some((build: any) => build.purpose === "preview");
    }, { timeout: 10000 }).toBe(true);
    await expect.poll(async () => {
      const response = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/builds`, { headers: { "X-API-Key": adminKey } });
      const build = (await response.json()).data.find((item: any) => item.purpose === "preview");
      if (build?.status === "failed") throw new Error(build.log);
      return build?.status;
    }, { timeout: 30000 }).toBe("succeeded");
    const editingRequest = modelRequests.filter(request => request.messages.some((message: any) => String(message.content).startsWith("用户已确认创建应用"))).at(-1);
    expect(editingRequest.messages.filter((message:any)=>message.role==="user"&&String(message.content).startsWith("用户已确认创建应用"))).toHaveLength(1);
    const editResult = editingRequest?.messages.filter((message: any) => message.role === "tool").at(-1);
    expect(editResult?.tool_call_id).toBe("creation-edit");
    expect(JSON.stringify(editResult)).not.toMatch(/isError|must read|not read|denied|error/i);
    const builds = (await (await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/builds`, { headers: { "X-API-Key": adminKey } })).json()).data;
    const preview = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/previews`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ buildId: builds[0].id }) });
    expect(preview.status).toBe(200);
    const opened = await fetch((await preview.json()).data.url, { redirect: "manual" });
    expect(opened.status).toBe(302);
    const cookie = opened.headers.get("set-cookie")!.split(";")[0];
    const entry = await fetch(new URL(opened.headers.get("location")!, opened.url), { headers: { Cookie: cookie } });
    expect(entry.status).toBe(200);
    const previewHtml = await entry.text();
    expect(previewHtml).toContain("native-created-app");
    const resourceBase = previewHtml.match(/data-localapp-app-resource-base="([^"]+)"/)![1];
    const compiled = await fetch(new URL(resourceBase + "index.html", entry.url), { headers: { Cookie: cookie } });
    expect(compiled.status).toBe(200);
    expect(await compiled.text()).toContain("Native edited application");
    const source = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/file?path=index.html`, { headers: { "X-API-Key": adminKey } });
    expect(await source.text()).toContain("Native edited application");
    if (process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1") {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        const browserPreview = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/previews`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ buildId: builds[0].id }) });
        await page.goto((await browserPreview.json()).data.url);
        await page.getByRole("heading", { name: "工作项", exact: true }).waitFor({ timeout: 15000 });
        await page.getByLabel("标题", { exact: true }).fill("Native preview business verification");
        await page.getByRole("button", { name: "创建", exact: true }).click();
        await page.getByText("Native preview business verification", { exact: true }).waitFor({ timeout: 10000 });
        await page.getByRole("button", { name: "开始", exact: true }).click();
        await page.getByRole("button", { name: "完成", exact: true }).click();
        await page.reload();
        await page.getByText("Native preview business verification", { exact: true }).waitFor({ timeout: 10000 });
        expect(await page.getByRole("button", { name: "开始", exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "完成", exact: true }).count()).toBe(0);
        const artifacts = path.resolve(dataDir, "..", "browser-evidence");
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, "native-edited-preview.png"), fullPage: true });
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    }
    const { syncSource } = await import("../../../localapp/src/commands/app-source.js");
    const checkout = path.join(dataDir, "local-source-checkout");
    const store = { resolve: async () => ({ name: "native-test", serverUrl: baseUrl, apiKey: adminKey }) };
    expect((await syncSource({ action: "pull", profile: "native-test", name: "native-created-app", directory: checkout, store })).status).toBe("pulled");
    const localIndex = path.join(checkout, "index.html");
    const localSource = await fs.readFile(localIndex, "utf8");
    expect(localSource).toContain("Native edited application");
    await fs.writeFile(localIndex, localSource.replace("Native edited application", "Native synchronized application"));
    expect((await syncSource({ action: "push", profile: "native-test", directory: checkout, store })).status).toBe("pushed");
    expect(await (await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/file?path=index.html`, { headers: { "X-API-Key": adminKey } })).text()).toContain("Native synchronized application");
    expect(await fs.readFile(path.join(checkout, ".localapp/source.json"), "utf8")).not.toContain(adminKey);
    const preservedHistory = await send("page", { request: { address: { kind: "session", sessionId: draft.sessionId }, throughSeq } });
    expect(await preservedHistory.text()).toContain("native creation plan");
    const releaseBuild = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/builds`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "release" }) });
    expect(releaseBuild.status).toBe(200);
    const releaseId = (await releaseBuild.json()).data.id;
    let releaseResult: any;
    await expect.poll(async () => {
      const response = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/builds/${releaseId}`, { headers: { "X-API-Key": adminKey } });
      const build = (await response.json()).data;
      const evidence = path.resolve(dataDir, "..", "browser-evidence");
      await fs.mkdir(evidence, { recursive: true });
      await fs.writeFile(path.join(evidence, "native-release-build.json"), JSON.stringify(build, null, 2));
      releaseResult = build;
      return ["succeeded", "failed", "cancelled"].includes(build.status);
    }, { timeout: 180000 }).toBe(true);
    expect(releaseResult.status, releaseResult.log).toBe("succeeded");
    const target = (await (await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/release-target`, { headers: { "X-API-Key": adminKey } })).json()).data;
    const publish = await fetch(`${baseUrl}/api/development/projects/${draft.projectId}/releases`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ buildId: releaseId, expectedVersion: target.version, idempotencyKey: "native-creation-release" }) });
    expect(publish.status).toBe(200);
    const published = (await publish.json()).data;
    expect(published.version).toBeGreaterThan(target.version);
    const formal = await fetch(baseUrl + published.url, { headers: { "X-API-Key": adminKey } });
    expect(formal.status).toBe(200);
    const publishedHtml = await formal.text();
    const publishedResourceBase = publishedHtml.match(/data-localapp-app-resource-base="([^"]+)"/)![1];
    expect(await (await fetch(new URL(publishedResourceBase + "index.html", formal.url), { headers: { "X-API-Key": adminKey } })).text()).toContain("Native synchronized application");
    if (process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1") {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const page = await browser.newPage();
        expect((await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-http-admin", password: "harness-test-password" } })).status()).toBe(200);
        await page.goto(baseUrl + published.url);
        await page.getByRole("heading", { name: "工作项", exact: true }).waitFor({ timeout: 15000 });
        expect(await page.getByText("Native preview business verification", { exact: true }).count()).toBe(0);
        await page.getByLabel("标题", { exact: true }).fill("Native published application record");
        await page.getByRole("button", { name: "创建", exact: true }).click();
        await page.getByText("Native published application record", { exact: true }).waitFor({ timeout: 10000 });
        await page.reload();
        await page.getByText("Native published application record", { exact: true }).waitFor({ timeout: 10000 });
        const artifacts = path.resolve(dataDir, "..", "browser-evidence");
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, "native-published-application.png"), fullPage: true });
      } finally { await browser.close(); }
    }
  }, 200000);

  it("retains native user history when switching model providers", async () => {
    createUser("user-provider-history", "user-provider-history", "not-used");
    const key = createApiKey("user-provider-history").key;
    const providers = ["first", "second"].map(id => ({ id, name: id, protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: id + "-model", apiKey: id + "-key" }));
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": key }, payload: { providers, defaultProviderId: "first", grants: {}, mcpServers: [] } })).statusCode).toBe(200);
    const rpc = async (providerId: string, method: string, args: unknown) => {
      const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId })).toString("base64url");
      const response = await fetch(baseUrl + `/api/agent/native/${scope}/api/session/${method}`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "user-provider-" + method, method: "session/" + method, payload: { args } }) });
      expect(response.status).toBe(200); return response.json();
    };
    const created = await rpc("first", "create", { request: {} });
    const sessionId = created.result.value.sessionId;
    await rpc("first", "rename", { request: { sessionId, title: "User provider history marker" } });
    expect((await rpc("first", "prompt", { request: { sessionId, requestId: "first-provider", mode: "queue", content: [{ type: "text", text: "native HTTP hello" }] } })).result.value.accepted).toBe(true);
    await expect.poll(async () => {
      const response = await fetch(baseUrl + `/api/agent/sessions/${sessionId}?providerId=first`, { headers: { "X-API-Key": key } });
      return (await response.text()).includes("native HTTP finished");
    }, { timeout: 5000 }).toBe(true);
    const firstScope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "first" })).toString("base64url");
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + `/api/agent/native/${firstScope}/api/remote.mux`, { headers: { "X-API-Key": key } });
    let throughSeq = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Provider history events not received")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", frame => {
          const text = frame.toString();
          for (const match of text.matchAll(/"seq":(\d+)/g)) throughSeq = Math.max(throughSeq, Number(match[1]));
          if (text.includes("native HTTP finished")) { clearTimeout(timer); resolve(); }
        });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "provider", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
      });
    } finally { socket.terminate(); }
    const switched = await rpc("second", "list", { _request: {} });
    expect(JSON.stringify(switched)).toContain(sessionId);
    expect(JSON.stringify(switched)).toContain("User provider history marker");
    const history = await rpc("second", "page", { request: { address: { kind: "session", sessionId }, throughSeq } });
    expect(JSON.stringify(history)).toContain("native HTTP hello");
    const continuation = "user switched provider continuation";
    expect((await rpc("second", "prompt", { request: { sessionId, requestId: "second-provider", mode: "queue", content: [{ type: "text", text: continuation }] } })).result.value.accepted).toBe(true);
    await expect.poll(() => modelRequests.some(request => request.messages.some((message: any) => message.content === continuation)), { timeout: 5000 }).toBe(true);
    const continuedRequest = modelRequests.find(request => request.messages.some((message: any) => message.content === continuation));
    expect(continuedRequest.model).toBe("second-model");
    expect(continuedRequest.authorization).toBe("Bearer second-key");
    expect(JSON.stringify(continuedRequest.messages)).toContain("native HTTP hello");
    expect(JSON.stringify(continuedRequest.messages)).toContain("native HTTP finished");
    await expect.poll(async () => {
      const response = await fetch(baseUrl + `/api/agent/sessions/${sessionId}?providerId=second`, { headers: { "X-API-Key": key } });
      const history = await response.json();
      return JSON.stringify(history).includes(continuation);
    }, { timeout: 5000 }).toBe(true);
  }, 15000);

  it.each([
    { role: "user", credential: "api-key" }, { role: "user", credential: "browser-session" },
    { role: "developer", credential: "api-key" }, { role: "developer", credential: "browser-session" },
    { role: "developer", credential: "project-access" },
  ])("closes an established $role native subscription when $credential credentials are revoked", async ({ role, credential }) => {
    const userId = "revoked-native-" + role + "-" + credential;
    const bcrypt = await import("bcryptjs");
    createUser(userId, userId, await bcrypt.hash("revocation-password", 10));
    const key = createApiKey(userId).key;
    let headers: Record<string, string> = { "X-API-Key": key };
    if (credential === "browser-session") {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: userId, password: "revocation-password" } });
      expect(login.statusCode).toBe(200);
      headers = { Cookie: String(login.headers["set-cookie"]).split(";", 1)[0] };
    }
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": key }, payload: { providers: [{ id: "own", name: "Own", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "revocation-model", apiKey: "revocation-model-key" }], defaultProviderId: "own", grants: {}, mcpServers: [] } })).statusCode).toBe(200);
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "own" })).toString("base64url");
    let prefix = `/api/agent/native/${scope}/api/`;
    let projectId: string | undefined;
    if (role === "developer") {
      const response = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": key }, payload: { name: "revocation-app" } });
      expect(response.statusCode).toBe(201);
      projectId = response.json().data.id;
      prefix = `/api/development/projects/${projectId}/native/own/api/`;
    }
    const created = await fetch(baseUrl + prefix + "session/create", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "revocation-create", method: "session/create", payload: { args: { request: {} } } }) });
    const sessionId = (await created.json()).result.value.sessionId;
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + prefix + "remote.mux", { headers });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native subscription not established")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.once("message", () => { clearTimeout(timer); resolve(); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "revocation", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const cancelledBefore = cancelledModelStreams;
      if (credential === "project-access") {
        const prompted = await fetch(baseUrl + prefix + "session/prompt", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "revocation-running-prompt", method: "session/prompt", payload: { args: { request: { sessionId, requestId: "revocation-running-turn", mode: "queue", content: [{ type: "text", text: "native cancellable stream" }] } } } }) });
        expect((await prompted.json()).result.value.accepted).toBe(true);
        await expect.poll(() => modelRequests.some(request => request.model === "revocation-model" && request.messages.some((message: any) => message.content === "native cancellable stream")), { timeout: 5000 }).toBe(true);
      }
      const closed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Revoked subscription remained open")), 3000);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (credential === "api-key") {
        getDb().run("DELETE FROM api_keys WHERE user_id = ?", [userId]); flushMetaDb();
      } else if (credential === "browser-session") {
        expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode).toBe(200);
      } else {
        createUser("replacement-project-owner", "replacement-project-owner", "not-used");
        getDb().run("UPDATE development_projects SET ownerId = ? WHERE id = ?", ["replacement-project-owner", projectId!]); flushMetaDb();
      }
      await closed;
      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect((await fetch(baseUrl + `/api/agent/sessions?providerId=own`, { headers })).status).toBe(credential === "project-access" ? 200 : 401);
      if (credential === "project-access") {
        await expect.poll(() => cancelledModelStreams, { timeout: 5000 }).toBe(cancelledBefore + 1);
        const denied = await fetch(baseUrl + prefix + "session/list", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "revoked-project-list", method: "session/list", payload: { args: { _request: {} } } }) });
        expect(denied.status).toBe(404);
      }
    } finally { socket.terminate(); }
  }, 15000);

  it("rejects switching providers while a native user turn is running", async () => {
    createUser("busy-provider-user", "busy-provider-user", "not-used");
    const key = createApiKey("busy-provider-user").key;
    const providers = ["busy-first", "busy-second"].map(id => ({ id, name: id, protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: id, apiKey: id }));
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": key }, payload: { providers, defaultProviderId: "busy-first", grants: {}, mcpServers: [] } })).statusCode).toBe(200);
    const send = (providerId: string, method: string, args: unknown) => {
      const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId })).toString("base64url");
      return fetch(baseUrl + `/api/agent/native/${scope}/api/session/${method}`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "busy-provider-" + method, method: "session/" + method, payload: { args } }) });
    };
    const sessionId = (await (await send("busy-first", "create", { request: {} })).json()).result.value.sessionId;
    const closedBefore = cancelledModelStreams;
    try {
      expect((await (await send("busy-first", "prompt", { request: { sessionId, requestId: "busy-provider", mode: "queue", content: [{ type: "text", text: "native cancellable stream" }] } })).json()).result.value.accepted).toBe(true);
      await expect.poll(() => modelRequests.some(request => request.model === "busy-first"), { timeout: 5000 }).toBe(true);
      const blocked = await send("busy-second", "list", { _request: {} });
      expect(blocked.status).toBe(400);
      expect(await blocked.text()).toContain("Wait for the current Agent turn to finish");
      expect(cancelledModelStreams).toBe(closedBefore);
      expect(modelRequests.some(request => request.model === "busy-second")).toBe(false);
    } finally {
      expect((await (await send("busy-first", "cancel", { request: { sessionId } })).json()).result.value.accepted).toBe(true);
    }
    await expect.poll(() => cancelledModelStreams, { timeout: 5000 }).toBe(closedBefore + 1);
    await expect.poll(async () => (await send("busy-second", "list", { _request: {} })).status, { timeout: 5000 }).toBe(200);
    expect(await (await send("busy-second", "list", { _request: {} })).text()).toContain(sessionId);
  }, 15000);

  it("retains native developer history when switching model providers", async () => {
    createUser("provider-history-owner", "provider-history-owner", "not-used");
    const providerKey = createApiKey("provider-history-owner").key;
    const original = { id: "mock", name: "Mock", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "mock-model", apiKey: "mock-key" };
    const selected = { ...original, id: "second", name: "Second", model: "second-model", apiKey: "second-key" };
    const save = (providers: unknown[]) => app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": providerKey }, payload: { providers, defaultProviderId: "mock", grants: {}, mcpServers: [] } });
    const project = (await (await fetch(baseUrl + "/api/development/projects", { method: "POST", headers: { "X-API-Key": providerKey, "Content-Type": "application/json" }, body: JSON.stringify({ name: "provider-history-app" }) })).json()).data;
    const send = (provider: string, method: string, args: unknown) => fetch(`${baseUrl}/api/development/projects/${project.id}/native/${provider}/api/session/${method}`, {
      method: "POST", headers: { "X-API-Key": providerKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "provider-" + method, method: "session/" + method, payload: { args } }),
    });
    try {
      expect((await save([original, selected])).statusCode).toBe(200);
      const created = await send("mock", "create", { request: {} });
      expect(created.status).toBe(200);
      const { sessionId } = (await created.json()).result.value;
      const prompt = await send("mock", "prompt", { request: { sessionId, requestId: "first-provider", mode: "queue", content: [{ type: "text", text: "native HTTP hello" }] } });
      expect((await prompt.json()).result.value.accepted).toBe(true);
      let throughSeq = 0;
      const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/development/projects/${project.id}/native/mock/api/remote.mux`, { headers: { "X-API-Key": providerKey } });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Provider trajectory timed out")), 10000);
          socket.once("error", error => { clearTimeout(timer); reject(error); });
          socket.on("message", frame => {
            const text = frame.toString();
            for (const match of text.matchAll(/"seq":(\d+)/g)) throughSeq = Math.max(throughSeq, Number(match[1]));
            if (text.includes("native HTTP finished")) { clearTimeout(timer); resolve(); }
          });
          socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "provider-trace", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
        });
      } finally { socket.terminate(); }
      const switched = await send("second", "page", { request: { address: { kind: "session", sessionId }, throughSeq } });
      expect(switched.status).toBe(200);
      const restored = (await switched.json()).result;
      expect(restored.ok).toBe(true);
      expect(JSON.stringify(restored.value.records)).toContain("native HTTP hello");
      expect(JSON.stringify(restored.value.records)).toContain("native HTTP finished");
      const resumed = await send("second", "prompt", { request: { sessionId, requestId: "second-provider", mode: "queue", content: [{ type: "text", text: "continue with second provider" }] } });
      expect((await resumed.json()).result.value.accepted).toBe(true);
      const secondDeadline = Date.now() + 10000;
      while (Date.now() < secondDeadline && !modelRequests.some(request => request.model === "second-model")) await new Promise(resolve => setTimeout(resolve, 25));
      const request = modelRequests.find(request => request.model === "second-model");
      expect(request?.authorization).toBe("Bearer second-key");
      expect(JSON.stringify(request?.messages)).toContain("native HTTP hello");
      expect(JSON.stringify(request?.messages)).toContain("native HTTP finished");
    } finally {
      expect((await save([original])).statusCode).toBe(200);
    }
  });

  it("executes developer file tools through native dsh and restores their trajectory",async()=>{
    const project=(await (await fetch(baseUrl+"/api/development/projects",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({name:"native-trace-app"})})).json()).data;
    const prefix=`/api/development/projects/${project.id}/native/mock/api`;
    const workspace=await fetch(baseUrl+prefix+"/workspace/initializeDefault",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"dev-workspace",method:"workspace/initializeDefault",payload:{args:{}}})});
    expect(workspace.status).toBe(200);
    const send=(method:string,args:unknown)=>fetch(baseUrl+prefix+"/session/"+method,{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"developer-"+method,method:"session/"+method,payload:{args}})});
    const {sessionId}=(await (await send("create",{request:{}})).json()).result.value;
    developerSessionId=sessionId;
    const prompt=await send("prompt",{request:{sessionId,requestId:"developer-file-read",mode:"queue",content:[{type:"text",text:"native developer read"}]}});
    expect((await prompt.json()).result.value).toEqual({accepted:true});
    let throughSeq=0;
    const socket=new WebSocket(baseUrl.replace("http:","ws:")+prefix+"/remote.mux",{headers:{"X-API-Key":adminKey}});
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error("Developer trajectory timed out")),10000);
        socket.once("error",error=>{clearTimeout(timer);reject(error);});
        socket.on("message",frame=>{
          const text=frame.toString();
          for(const match of text.matchAll(/"seq":(\d+)/g)) throughSeq=Math.max(throughSeq,Number(match[1]));
          if(text.includes("native developer finished")){clearTimeout(timer);resolve();}
        });
        socket.once("open",()=>socket.send(JSON.stringify({type:"open",streamId:"developer-trace",endpoint:"session/follow",payload:{args:{request:{address:{kind:"session",sessionId}}}}})));
      });
    } finally {socket.terminate();}
    const page=await send("page",{request:{address:{kind:"session",sessionId},throughSeq}});
    const trajectory=await page.text();
    expect(trajectory).toContain("native developer finished");expect(trajectory).toContain("manifest.json");expect(trajectory).toContain("native-trace-app");
    const records = JSON.parse(trajectory).result.value.records;
    const events = records.filter((record:any) => record.type === "event").map((record:any) => record.event);
    expect(events.some((event:any) => event.type === "assistant/message" && event.data.message.content.some((block:any) => block.type === "reasoning" && block.text.includes("native developer reasoning")))).toBe(true);
    expect(events.some((event:any) => event.type === "request/header")).toBe(true);
    expect(events.some((event:any) => event.type === "tool/call" && event.data.name === "read")).toBe(true);
    expect(events.some((event:any) => event.type === "tool/result" && !event.data.message.isError)).toBe(true);
    expect(events.every((event:any) => Number.isFinite(event.time))).toBe(true);
    expect(events.map((event:any) => event.seq)).toEqual([...events.map((event:any) => event.seq)].sort((a:number,b:number) => a-b));

    await expect.poll(async()=>{
      const response=await fetch(`${baseUrl}/api/development/projects/${project.id}/builds`,{headers:{"X-API-Key":adminKey}});
      const builds=(await response.json()).data;
      return builds.length>0&&!builds.some((build:any)=>["queued","running"].includes(build.status));
    },{timeout:20000}).toBe(true);
    const repeated=await send("prompt",{request:{sessionId,requestId:"developer-file-read",mode:"queue",content:[{type:"text",text:"native developer read"}]}});
    expect((await repeated.json()).result.value).toEqual({accepted:true});
    const saveAfterRetry=await fetch(`${baseUrl}/api/development/projects/${project.id}/file`,{method:"PUT",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({path:"native-retry-marker.txt",content:"No stale mutation lock",hash:null})});
    expect(saveAfterRetry.status,await saveAfterRetry.text()).toBe(200);

    const fork=await send("fork",{request:{sessionId}});
    expect(fork.status).toBe(200);
    const forkId=(await fork.json()).result.value.sessionId;
    expect(forkId).not.toBe(sessionId);
    await send("rename",{request:{sessionId:forkId,title:"Native fork branch"}});
    const forkHistory=await send("page",{request:{address:{kind:"session",sessionId:forkId},throughSeq}});
    const forkTrajectory = await forkHistory.text();
    expect(forkTrajectory).toContain("native developer read");
    expect(forkTrajectory).toContain("native developer reasoning");
    const projections=await send("projections",{request:{sessionId:forkId}});
    expect(projections.status).toBe(200);expect((await projections.json()).result.ok).toBe(true);
    const workspaceCommand = async (method:string) => {
      const response = await fetch(baseUrl+prefix+"/workspace/"+method, {
        method:"POST", headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},
        body:JSON.stringify({type:"client-request",rpcId:"workspace-"+method,method:"workspace/"+method,payload:{args:{request:{sessionId:forkId}}}}),
      });
      expect(response.status).toBe(200);
      const result=(await response.json()).result;
      expect(result.ok).toBe(true);
      return result.value;
    };
    expect((await workspaceCommand("pinSession")).pinnedSessionIds).toContain(forkId);
    expect((await workspaceCommand("unpinSession")).pinnedSessionIds).not.toContain(forkId);
    expect((await workspaceCommand("archiveSession")).archivedSessionIds).toContain(forkId);
    expect((await workspaceCommand("unarchiveSession")).archivedSessionIds).not.toContain(forkId);
    const requests=modelRequests.filter(item=>item.messages.some((message:any)=>message.content==="native developer read"));
    expect(requests.some(item=>item.messages.some((message:any)=>message.role==="tool"&&JSON.stringify(message).includes("native-trace-app")))).toBe(true);
    const outsider=await fetch(baseUrl+prefix+"/session/page",{method:"POST",headers:{"X-API-Key":outsiderKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"foreign",method:"session/page",payload:{args:{request:{address:{kind:"session",sessionId},throughSeq:0}}}})});
    expect(outsider.status).toBe(404);
  },30000);
  it("uploads binary attachments through native routes with user and session isolation",async()=>{
    const scope=Buffer.from(JSON.stringify({appId:"platform",providerId:"mock"})).toString("base64url");
    const project=(await (await fetch(baseUrl+"/api/development/projects",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({name:"native-upload-app"})})).json()).data;
    for(const prefix of [`/api/agent/native/${scope}/api/session/`,`/api/development/projects/${project.id}/native/mock/api/session/`]){
      const create=await fetch(baseUrl+prefix+"create",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"upload-create",method:"session/create",payload:{args:{request:{}}}})});
      const sessionId=(await create.json()).result.value.sessionId;
      const bytes=Buffer.from([0x25,0x50,0x44,0x46,0,0xff,0x80,0x0a]);
      const upload=(key:string,id=sessionId,type="application/octet-stream")=>fetch(baseUrl+prefix+`uploadFileBinary?sessionId=${encodeURIComponent(id)}&name=sample.pdf`,{method:"POST",headers:{"X-API-Key":key,"Content-Type":type},body:bytes});
      const response=await upload(adminKey);expect(response.status).toBe(200);
      const receipt=await response.json();expect(receipt.ok).toBe(true);expect(receipt.value.receiptId).toEqual(expect.any(String));expect(receipt.value.file).toMatchObject({name:"sample.pdf",bytes:bytes.length});
      const other=await fetch(baseUrl+prefix+"create",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"other-upload-create",method:"session/create",payload:{args:{request:{}}}})});
      const otherSession=(await other.json()).result.value.sessionId;
      const foreignReceipt=await fetch(baseUrl+prefix+"prompt",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"foreign-receipt",method:"session/prompt",payload:{args:{request:{sessionId:otherSession,requestId:"foreign-file",mode:"queue",content:[{type:"file",receiptId:receipt.value.receiptId}]}}}})});
      expect(await foreignReceipt.text()).toContain("FILE_NOT_STAGED");
      expect((await upload(outsiderKey)).status).toBe(prefix.includes("development")?404:400);
      expect((await upload(adminKey,sessionId,"text/plain")).status).toBe(415);
      const missing=await upload(adminKey,"unknown-upload-session");expect((await missing.json()).ok).toBe(false);
    }
  });
  it("keeps native session rename search and cancellation inside the owner runtime",async()=>{
    const project=(await (await fetch(baseUrl+"/api/development/projects",{headers:{"X-API-Key":adminKey}})).json()).data.find((item:any)=>item.name==="native-trace-app");
    const scope=Buffer.from(JSON.stringify({appId:"platform",providerId:"mock"})).toString("base64url");
    for(const prefix of [`/api/agent/native/${scope}/api/session/`,`/api/development/projects/${project.id}/native/api/session/`]) {
      const send=(method:string,request:unknown,key=adminKey)=>fetch(baseUrl+prefix+method,{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"control-"+method,method:"session/"+method,payload:{args:method==="list"?{_request:{}}:{request}}})});
      const {sessionId}=(await (await send("create",{})).json()).result.value;
      const title="Native isolated control "+sessionId;
      expect((await (await send("rename",{sessionId,title})).json()).result.value.title).toBe(title);
      const query=prefix.includes("development")?"native developer read":"native HTTP hello";
      const search=await send("search",{query});expect(search.status).toBe(200);expect(await search.text()).toContain(query);
      expect((await (await send("cancel",{sessionId})).json()).result.value).toEqual({accepted:true});
      for(const method of ["rename","search","cancel"]) {
        const response=await send(method,method==="search"?{query}:{sessionId,title:"foreign title"},outsiderKey);
        expect(response.status).toBe(prefix.includes("development")?404:400);
      }
      expect(await (await send("list",{})).text()).toContain(title);
    }
  },30000);
  it("aborts an active native model stream when the owner cancels",async()=>{
    const project=(await (await fetch(baseUrl+"/api/development/projects",{headers:{"X-API-Key":adminKey}})).json()).data.find((item:any)=>item.name==="native-trace-app");
    const scope=Buffer.from(JSON.stringify({appId:"platform",providerId:"mock"})).toString("base64url");
    for(const prefix of [`/api/agent/native/${scope}/api/session/`,`/api/development/projects/${project.id}/native/api/session/`]) {
      const send=(method:string,request:unknown)=>fetch(baseUrl+prefix+method,{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"cancel-stream-"+method,method:"session/"+method,payload:{args:{request}}})});
      const {sessionId}=(await (await send("create",{})).json()).result.value;
      const count=()=>modelRequests.filter(item=>item.messages.some((message:any)=>message.content==="native cancellable stream")).length;
      const before=count(),closedBefore=cancelledModelStreams;
      expect((await (await send("prompt",{sessionId,requestId:"cancel-stream",mode:"queue",content:[{type:"text",text:"native cancellable stream"}]})).json()).result.value).toEqual({accepted:true});
      await expect.poll(count,{timeout:5000}).toBe(before+1);
      if (prefix.includes("development")) {
        const status = await app.inject({ method: "GET", url: `/api/development/projects/${project.id}`, headers: { "X-API-Key": adminKey } });
        expect(status.json().data.busy).toBe(true);
      }
      const legacyUrl=prefix.includes("development")?`/api/development/projects/${project.id}/agent/run`:"/api/agent/run";
      const legacyRun=()=>fetch(baseUrl+legacyUrl,{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({sessionId,providerId:"mock",prompt:"native cancellable stream",systemPrompt:"Keep the same session",tools:[]})});
      const concurrent=await legacyRun();expect(await concurrent.text()).toMatch(/Agent session is already running|项目正在占用/);
      expect(count()).toBe(before+1);
      expect((await (await send("cancel",{sessionId})).json()).result.value).toEqual({accepted:true});
      await expect.poll(()=>cancelledModelStreams,{timeout:5000}).toBe(closedBefore+1);
      await expect.poll(async()=>{
        const response=await fetch(baseUrl+prefix+"list",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"idle",method:"session/list",payload:{args:{_request:{}}}})});
        return (await response.json()).result.value.items.find((row:any)=>row.sessionId===sessionId||row.id===sessionId)?.running;
      },{timeout:5000}).toBe(false);
      if (prefix.includes("development")) {
        await expect.poll(async () => {
          const status = await app.inject({ method: "GET", url: `/api/development/projects/${project.id}`, headers: { "X-API-Key": adminKey } });
          return status.json().data.busy;
        }, { timeout: 5000 }).toBe(false);
      }
      const legacy=await legacyRun();
      await expect.poll(count,{timeout:5000}).toBe(before+2);
      expect(await (await send("prompt",{sessionId,requestId:"parallel-native",mode:"queue",content:[{type:"text",text:"parallel native"}]})).text()).toContain("already running through the application transport");
      expect(count()).toBe(before+2);
      await send("cancel",{sessionId});await legacy.text();
      await expect.poll(()=>cancelledModelStreams,{timeout:5000}).toBe(closedBefore+2);
    }
  },20000);
  it("binds application tools and prompt to a native session with owner-only tool results",async()=>{
    const scope=Buffer.from(JSON.stringify({appId:"platform",providerId:"mock"})).toString("base64url");
    const send=(method:string,request:unknown)=>fetch(`${baseUrl}/api/agent/native/${scope}/api/session/${method}`,{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"app-"+method,method:"session/"+method,payload:{args:{request}}})});
    const {sessionId}=(await (await send("create",{})).json()).result.value;
    const binding={sessionId,appId:"platform",providerId:"mock",systemPrompt:"Native application prompt marker",tools:[{name:"echo",description:"Application echo",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]};
    const bind=(key:string)=>fetch(baseUrl+"/api/agent/native-context",{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify(binding)});
    expect((await bind(outsiderKey)).status).toBe(400);expect((await bind(adminKey)).status).toBe(200);
    const controller=new AbortController();
    const stream=await fetch(baseUrl+"/api/agent/events?sessionId="+sessionId+"&appId=platform&providerId=mock",{headers:{"X-API-Key":adminKey},signal:controller.signal});
    const reader=stream.body!.getReader();
    try {
      expect((await (await send("prompt",{sessionId,requestId:"native-app-tools",mode:"queue",content:[{type:"text",text:"native application echo"}]})).json()).result.value).toEqual({accepted:true});
      let buffered="",event:any;
      while(!event) {
        const next=await reader.read();if(next.done)throw Error("Tool event stream closed");buffered+=new TextDecoder().decode(next.value);
        const frames=buffered.split("\n\n");buffered=frames.pop()!;
        for(const frame of frames) if(frame.startsWith("data: ")) {const value=JSON.parse(frame.slice(6));if(value.type==="tool_call")event=value;}
      }
      expect(event.name).toBe("echo");expect(event.args).toEqual({text:"hello"});
      const result=(key:string)=>fetch(baseUrl+"/api/agent/tool-result",{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify({token:event.token,result:{echo:"native application result"}})});
      expect((await result(outsiderKey)).status).toBe(404);expect((await result(adminKey)).status).toBe(200);
      await expect.poll(()=>modelRequests.some(item=>item.messages.some((message:any)=>message.role==="tool"&&JSON.stringify(message).includes("native application result"))),{timeout:5000}).toBe(true);
      const request=modelRequests.find(item=>item.messages.some((message:any)=>message.content==="native application echo"));
      expect(JSON.stringify(request.messages)).toContain("Native application prompt marker");
    } finally {controller.abort();await reader.cancel().catch(()=>{});}
  },15000);
  it("executes registered SDK tools in a native session over the unified Server",async()=>{
    const {HarnessAgent}=await import("../../../sdk-agent/src/harness-client.js");
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{const headers=new Headers(init?.headers);headers.set("X-API-Key",adminKey);return originalFetch(input,{...init,headers});};
    const agent=new HarnessAgent({proxyUrl:baseUrl,appId:"platform",initialState:{systemPrompt:"SDK native application prompt"}});agent.providerId="mock";
    let executed=0;
    agent.state.tools=[{name:"echo",description:"SDK application echo",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]},execute:async (_callId,args)=>{expect(args).toEqual({text:"hello"});executed++;return {content:[],details:{echo:"SDK native result",input:args}};}}];
    try {
      const connected=await agent.connectNativeSession();
      const response=await originalFetch(connected.url+"api/session/prompt",{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:"sdk-prompt",method:"session/prompt",payload:{args:{request:{sessionId:connected.sessionId,requestId:"sdk-native-tools",mode:"queue",content:[{type:"text",text:"SDK native echo"}]}}}})});
      expect((await response.json()).result.value).toEqual({accepted:true});
      await expect.poll(()=>modelRequests.some(item=>item.messages.some((message:any)=>message.role==="tool"&&JSON.stringify(message).includes("SDK native result"))),{timeout:5000}).toBe(true);
      expect(executed).toBe(1);expect(agent.state.errorMessage).toBeUndefined();
    } finally {agent.dispose();globalThis.fetch=originalFetch;}
  },15000);
  it("pins native client transport paths to the selected provider and application", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const send = (key: string, token = scope) => fetch(baseUrl + "/api/agent/native/" + token + "/api/session/list?appId=missing/application&providerId=missing", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "scoped-list", method: "session/list", payload: { args: { _request: {} } } }),
    });
    const response = await send(adminKey); expect(response.status).toBe(200);
    expect(await response.text()).toContain("http-e2e-session");
    expect((await send(adminKey, "invalid")).status).toBe(400);
    expect((await send(outsiderKey)).status).toBe(400);
  });
  it("serves the original native boot page and scoped plugin bundles", async () => {
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const url = baseUrl + "/api/agent/native/" + scope + "/";
    expect((await fetch(url)).status).toBe(401);
    const page = await fetch(url, { headers: { "X-API-Key": adminKey } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("__DSH_BOOT__");
    expect(html).toContain("__ModuleLoader__");
    expect(html).toContain("dsh-client-ui-trajectory");
    expect(html).toContain(url.replace(baseUrl, ""));
    const entry = await fetch(url + "client/entry.js", { headers: { "X-API-Key": adminKey } });
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain("Native client mount point is missing");
    const resource = html.match(/"id":"@deepseek-ai\/dsh-client-ui-trajectory"[^}]*"url":"([^"]+)"/)?.[1];
    expect(resource).toBeDefined();
    const plugin = await fetch(url + resource, { headers: { "X-API-Key": adminKey } });
    expect(plugin.status).toBe(200);
    expect((await plugin.text()).length).toBeGreaterThan(100);
  });
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1").each([false, true])("opens administrator document extension controls with startup control %s", async controlled => {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    try {
      expect((await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-http-admin", password: "harness-test-password" } })).status()).toBe(200);
      await page.route("**/api/system/settings/plugins", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, data: { combination: "full", controlledByEnvironment: controlled, documentsEnabled: true, documentsControlled: false } }) }));
      await page.goto(baseUrl + "/my/system?tab=plugins");
      await page.getByRole("tab", { name: "Python 环境", exact: true }).click();
      await page.getByLabel("虚拟环境 Python 路径", { exact: true }).waitFor();
      await page.getByRole("button", { name: "创建专用虚拟环境", exact: true }).click();
      await page.getByLabel("基础 Python 路径（3.10+）", { exact: true }).waitFor();
      expect(await page.getByRole("switch", { name: "同时安装公共文档 Skills 依赖", exact: true }).getAttribute("aria-checked")).toBe("false");
      await page.getByRole("tab", { name: "插件组合", exact: true }).click();
      const toggle = page.getByRole("switch", { name: "公共文档 Skills" });
      await toggle.waitFor();
      expect(await toggle.getAttribute("aria-checked")).toBe("true");
      await toggle.click();
      expect(await toggle.getAttribute("aria-checked")).toBe("false");
      expect(await page.getByRole("button", { name: "保存并重启" }).isEnabled()).toBe(true);
      const select = page.getByRole("combobox");
      if (controlled) {
        expect(await select.isDisabled()).toBe(true);
        return;
      }
      await select.click();
      await page.getByRole("option", { name: "多人 Agent" }).waitFor();
      const artifacts = path.resolve(dataDir, "..", "browser-evidence");
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "document-extension-settings.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await expect.poll(() => select.evaluate(element => element === document.activeElement)).toBe(true);
      await select.press("ArrowDown");
      await page.getByRole("option", { name: "多人 Agent" }).click();
      expect(await select.textContent()).toContain("多人 Agent");
    } finally { await browser.close(); }
  }, 30000);
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1").each(["http", "network"] as const)("keeps plugin navigation and development settings hidden after a %s status failure", async failure => {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    const developmentRequests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/system/development-environment")) developmentRequests.push(request.url()); });
    try {
      expect((await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-http-admin", password: "harness-test-password" } })).status()).toBe(200);
      await page.route("**/api/system/plugins", route => failure === "network" ? route.abort("failed") : route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: true, data: { applications: true, development: true } }) }));
      await page.goto(baseUrl + "/my/info");
      await page.getByRole("link", { name: "用户管理", exact: true }).waitFor();
      expect(await page.getByRole("link", { name: "应用开发", exact: true }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "我的应用", exact: true }).count()).toBe(0);
      await page.goto(baseUrl + "/my/system?tab=development");
      await page.getByRole("tab", { name: "Python 环境", exact: true }).waitFor();
      await expect.poll(() => page.getByRole("tab", { name: "插件组合", exact: true }).getAttribute("aria-selected")).toBe("true");
      expect(await page.getByRole("tab", { name: "应用开发环境", exact: true }).count()).toBe(0);
      expect(developmentRequests).toEqual([]);
      const artifacts = path.resolve(dataDir, "..", "browser-evidence");
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "plugin-status-failure-" + failure + ".png"), fullPage: true });
    } finally { await browser.close(); }
  }, 30000);
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("opens the platform creation dialog with accessible model selection", async () => {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    try {
      const login = await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-http-admin", password: "harness-test-password" } });
      expect(login.status()).toBe(200);
      await page.goto(baseUrl + "/my/apps");
      const trigger = page.getByRole("button", { name: "创建应用", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox").click();
      await page.getByRole("option").first().waitFor();
      const artifacts = path.resolve(dataDir, "..", "browser-evidence");
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "creation-model-select.png") });
      await page.keyboard.press("Escape");
      await expect(dialog.isVisible()).resolves.toBe(true);
      await dialog.getByRole("combobox").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
      await trigger.click();
      let creationRequests = 0;
      let legacyCreationRuns=0;
      page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname.endsWith("/agent/run"))legacyCreationRuns++;});
      let promptAttempts = 0;
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/development/creations") creationRequests++; });
      await page.route("**/api/session/create", async route => {
        const created = await route.fetch();
        expect(created.status()).toBe(200);
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test lost creation response" }) });
      });
      await page.route("**/api/session/prompt", async route => {
        if (++promptAttempts === 1) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { ok: true, value: { accepted: false } } }) });
        else await route.continue();
      });
      await dialog.getByLabel("创建应用需求").fill("native creation browser plan");
      await dialog.getByLabel("发送创建需求").click();
      await dialog.getByRole("alert").filter({ hasText: "需求未发送" }).waitFor();
      expect(await dialog.getByRole("combobox").isDisabled()).toBe(true);
      await dialog.getByLabel("发送创建需求").click();
      const native = page.frameLocator('iframe[title="原生应用开发对话"]');
      await native.getByText("native creation proposed", { exact: true }).first().waitFor({ timeout: 20000 });
      expect(creationRequests).toBe(1);
      expect(promptAttempts).toBe(2);
      await page.reload();
      await page.getByRole("button", { name: "创建应用", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: /native-browser-created-app/ }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "creation-draft-resume.png") });
      await page.getByRole("dialog").getByRole("button", { name: /native-browser-created-app/ }).click();
      await native.getByText("native creation proposed", { exact: true }).first().waitFor({ timeout: 10000 });
      expect(creationRequests).toBe(1);
      expect(promptAttempts).toBe(2);
      await dialog.getByRole("button", { name: "确认名称并创建" }).waitFor({ timeout: 10000 });
      await page.screenshot({ path: path.join(artifacts, "creation-native-proposal.png") });
      await dialog.getByRole("button", { name: "确认名称并创建" }).click();
      await page.waitForURL(/\/harness-http-admin\/native-browser-created-app\//, { timeout: 20000 });
      expect(page.url()).toContain("creation=");
      const restored = page.frameLocator('iframe[title="原生应用开发对话"]');
      await restored.getByText("native creation proposed", { exact: true }).first().waitFor({ timeout: 20000 });
      const frameBounds = await page.locator('iframe[title="原生应用开发对话"]').boundingBox();
      expect(frameBounds!.height).toBeGreaterThan(300);
      await restored.getByText("轨迹", { exact: true }).first().click();
      await restored.getByText("propose_application", { exact: false }).first().waitFor({ timeout: 10000 });
      await page.screenshot({ path: path.join(artifacts, "creation-native-trajectory.png") });
      await restored.getByText("对话", { exact: true }).first().click();
      await restored.getByText("native application edited",{exact:true}).first().waitFor({timeout:20000});
      await page.frameLocator('iframe[title="应用开发预览"]').getByRole("heading",{name:"工作项",exact:true}).waitFor({timeout:30000});
      expect(legacyCreationRuns).toBe(0);
      await page.screenshot({ path: path.join(artifacts, "creation-native-handoff.png") });
    } finally { await browser.close(); }
  }, 60000);
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("executes application browser tools from an embedded native conversation",async()=>{
    const {build}=await import("esbuild");
    const sdk=path.resolve(__dirname,"../../../sdk-agent/src/harness-client.ts");
    const bridge=path.resolve(__dirname,"../../../sdk-agent/src/native-frame-bridge.ts");
    const built=await build({stdin:{contents:`import {HarnessAgent} from ${JSON.stringify(sdk)};import {attachNativeFrame} from ${JSON.stringify(bridge)};const agent=new HarnessAgent({appId:"platform",initialState:{systemPrompt:"Browser application context"}});agent.providerId="mock";window.toolCalls=0;agent.state.tools=[{name:"echo",description:"Browser tool",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]},execute:async(_id,args)=>{window.toolCalls++;return {content:[],details:{echo:"Browser native tool result",args}};}}];const dispose=attachNativeFrame(document.querySelector("iframe"),agent);window.addEventListener("pagehide",()=>{dispose();agent.dispose();},{once:true});`,resolveDir:path.dirname(sdk),loader:"ts"},bundle:true,write:false,format:"iife",platform:"browser"});
    const scope=Buffer.from(JSON.stringify({appId:"platform",providerId:"mock"})).toString("base64url");
    const {chromium}=await import("@playwright/test");const browser=await chromium.launch({channel:"chrome",headless:true});
    const page=await browser.newPage({extraHTTPHeaders:{"X-API-Key":adminKey}});const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/__native-application-host",route=>route.fulfill({contentType:"text/html",body:`<!doctype html><iframe title="Native application conversation" src="/api/agent/native/${scope}/?localappBridge=1" style="width:100%;height:95vh;border:0"></iframe><script>${built.outputFiles[0].text}</script>`}));
    try {
      await page.addInitScript(()=>{(window as any).nativeSelections=[];window.addEventListener("message",event=>{if(event.origin===window.location.origin&&event.data?.type==="localapp:native-selection")(window as any).nativeSelections.push(event.data.state);});});
      await page.goto(baseUrl+"/__native-application-host");const frame=page.frameLocator("iframe");
      const input=frame.locator("textarea, [contenteditable=true]").first();await input.waitFor({timeout:10000});
      expect(await frame.getByLabel("应用开发上下文").count()).toBe(0);
      const uploads:Array<{status:number;body:any}>=[];
      await page.route("**/uploadFileBinary?*",async route=>{const response=await route.fetch();uploads.push({status:response.status(),body:await response.json()});await route.fulfill({response});});
      await frame.getByRole("button",{name:"添加文件或调用指令"}).click();
      const [chooser]=await Promise.all([page.waitForEvent("filechooser",{timeout:5000}),frame.getByText("文件",{exact:true}).click()]);
      await chooser.setFiles([
        {name:"sample.pdf",mimeType:"application/pdf",buffer:await fs.readFile(path.join(__dirname,"fixtures/resume.pdf"))},
        {name:"sample.docx",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",buffer:await fs.readFile(path.join(__dirname,"fixtures/document.docx"))},
      ]);
      await expect.poll(()=>uploads.length,{timeout:10000}).toBe(2);
      for(const response of uploads){expect(response.status).toBe(200);expect(response.body.ok).toBe(true);}
      await expect.poll(()=>frame.locator("body").textContent(),{timeout:5000}).toContain("sample.pdf");
      await expect.poll(()=>frame.locator("body").textContent(),{timeout:5000}).toContain("sample.docx");
      await input.fill("browser native echo");await input.press("Enter");
      await frame.getByText("工具已完成",{exact:true}).first().waitFor({timeout:10000});
      expect(await page.evaluate(()=>(window as any).toolCalls)).toBe(1);
      await page.waitForFunction(()=>(window as any).nativeSelections.some((state:any)=>state?.sessionId&&typeof state.title==="string"),{},{timeout:5000});
      const originalSession=await page.evaluate(()=>(window as any).nativeSelections.findLast((item:any)=>item?.sessionId).sessionId);
      await page.evaluate(()=>document.querySelector("iframe")!.contentWindow!.postMessage({type:"localapp:native-new-session"},window.location.origin));
      await page.waitForFunction((original:string)=>(window as any).nativeSelections.findLast((item:any)=>item?.sessionId)?.sessionId!==original,originalSession,{timeout:5000});
      await page.evaluate((sessionId:string)=>document.querySelector("iframe")!.contentWindow!.postMessage({type:"localapp:native-select",sessionId},window.location.origin),originalSession);
      await page.waitForFunction((original:string)=>(window as any).nativeSelections.findLast((item:any)=>item?.sessionId)?.sessionId===original,originalSession,{timeout:5000});
      await frame.getByText("轨迹",{exact:true}).click();await frame.getByText("echo",{exact:true}).first().waitFor({timeout:5000});
      expect(await frame.locator("body").innerText()).toContain("文件 ×2");
      expect(await frame.locator("body").innerText()).toContain("Browser native tool result");expect(errors).toEqual([]);
    } finally {const artifacts=path.resolve(dataDir,"..","browser-evidence");await fs.mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,"native-application-frame.png"),fullPage:true});await browser.close();}
  },30000);
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("renders developer sessions with the original dsh trajectory UI",async()=>{
    const projects=(await (await fetch(baseUrl+"/api/development/projects",{headers:{"X-API-Key":adminKey}})).json()).data;
    const project=projects.find((item:any)=>item.name==="native-trace-app");expect(project).toBeDefined();
    // Continue this same session through the former transport before returning
    // to the native UI, as creation handoff and existing histories do.
    const legacy=await fetch(`${baseUrl}/api/development/projects/${project.id}/agent/run`,{method:"POST",headers:{"X-API-Key":adminKey,"Content-Type":"application/json"},body:JSON.stringify({sessionId:developerSessionId,providerId:"mock",prompt:"native developer read"})});
    expect(legacy.status).toBe(200);expect(await legacy.text()).not.toContain('"type":"error"');
    const {chromium}=await import("@playwright/test");
    const browser=await chromium.launch({channel:"chrome",headless:true});
    const page=await browser.newPage({extraHTTPHeaders:{"X-API-Key":adminKey}});
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    const questionWire:string[]=[];
    // Capture the real client plugin's Fiber through the public module loader.
    // This instrumentation exists only in the browser test, never in production.
    await page.addInitScript(() => {
      let loader: any;
      Object.defineProperty(window, "__ModuleLoader__", {
        configurable: true, get: () => loader,
        set: value => {
          loader = value;
          const wrap = (load: any) => (registration: any) => load.call(value, { ...registration, factory: (require: any) => {
            const exports = registration.factory(require);
            if (registration.id !== "@localapp/dsh-app-development") return exports;
            return { ...exports, apply: (ctx: any) => {
              (window as any).unloadDevelopmentClient = () => ctx.fiber.dispose();
              return exports.apply(ctx);
            } };
          } });
          let load = wrap(value.load);
          // Bootstrap changes the queue facade to live loading in place.
          Object.defineProperty(value, "load", {
            configurable: true, get: () => load, set: next => { load = wrap(next); },
          });
        },
      });
    });
    page.on("websocket",socket=>{socket.on("framesent",frame=>{if(String(frame.payload).includes("question")||String(frame.payload).includes("蓝色"))questionWire.push("sent "+frame.payload);});socket.on("framereceived",frame=>{if(String(frame.payload).includes("question")||String(frame.payload).includes("蓝色"))questionWire.push("received "+frame.payload);});});
    try {
      await page.goto(`${baseUrl}/api/development/projects/${project.id}/native/mock/`);
      await expect.poll(() => page.getByLabel("应用开发上下文").innerText(), { timeout: 10000 }).toBe("开发者模式 · native-trace-app");
      await page.getByText("native developer read",{exact:true}).first().click({timeout:15000});
      await page.getByText("native developer finished",{exact:true}).first().waitFor({timeout:10000});
      await page.getByText("轨迹",{exact:true}).click();
      await page.locator('[aria-label="轨迹工具栏"]').waitFor({timeout:5000});
      await page.getByText("read",{exact:true}).first().waitFor({timeout:5000});
      await page.getByText("native developer reasoning: inspect the application manifest", { exact: false }).first().waitFor({ timeout: 5000 });
      await page.reload();
      await page.getByText("native developer finished",{exact:true}).first().waitFor({timeout:10000});
      await page.getByText("native developer reasoning: inspect the application manifest", { exact: false }).first().waitFor({ timeout: 5000 });
      const goalRpc = async (method: string, args: Record<string, unknown> = {}) => {
        const response = await app.inject({ method: "POST", url: `/api/development/projects/${project.id}/native/mock/api/goals/${method}`, headers: { "X-API-Key": adminKey }, payload: { type: "client-request", rpcId: "goal-" + method, method: "goals/" + method, payload: { args: { agentId: developerSessionId, ...args } } } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().result.ok, response.body).toBe(true);
        return response.json().result.value;
      };
      const createdGoal = await goalRpc("create", { request: { objective: "Verify native developer goal", maxGoalRounds: 30 } });
      await goalRpc("pause", { ref: createdGoal.ref });
      await page.getByText("Verify native developer goal", { exact: true }).first().waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "恢复目标", exact: true }).waitFor({ timeout: 5000 });
      await expect.poll(async () => (await goalRpc("get")).phase).toBe("paused");
      await page.reload();
      await page.getByText("Verify native developer goal", { exact: true }).first().waitFor({ timeout: 5000 });
      const goal = await goalRpc("get");
      expect(goal.activation).toBe("disarmed");
      await goalRpc("clear", { ref: { id: goal.id, revision: goal.revision } });
      const input=page.locator("textarea, [contenteditable=true]").first();
      await input.fill("@manifest");
      await page.getByRole("option").filter({ hasText: "manifest.json" }).first().waitFor({ timeout: 5000 });
      await input.press("Escape");
      await input.fill("native developer question");await input.press("Enter");
      await page.getByText("选择应用颜色",{exact:true}).first().waitFor({timeout:10000});
      const choice=page.getByRole("radio",{name:"蓝色",exact:true});
      await choice.click({timeout:5000});
      await expect.poll(()=>choice.getAttribute("aria-checked"),{timeout:5000}).toBe("true");
      await page.getByRole("button",{name:"提交",exact:true}).click({timeout:5000});
      await page.getByText("native question finished",{exact:true}).first().waitFor({timeout:10000});
      expect(modelRequests.some(request=>request.messages.some((message:any)=>message.role==="tool"&&JSON.stringify(message).includes("蓝色")&&JSON.stringify(message).includes("color")))).toBe(true);
      await page.reload();
      await page.getByText("native question finished",{exact:true}).first().waitFor({timeout:10000});
      expect(await page.locator("body").innerText()).toContain("蓝色");
      // The fork inherits completed turns; cancellation must not alter the parent.
      await page.getByText("对话", { exact: true }).first().click({ timeout: 5000 });
      await page.getByRole("button", { name: "在新对话中分支", exact: true }).last().click({ timeout: 5000 });
      await page.getByText("native developer read (1)", { exact: true }).last().waitFor({ timeout: 5000 });
      await page.getByText("native question finished", { exact: true }).first().waitFor({ timeout: 5000 });
      const cancelledBefore = cancelledModelStreams;
      const requestsBefore = modelRequests.length;
      await input.fill("native cancellable stream");
      await input.press("Enter");
      await expect.poll(() => modelRequests.slice(requestsBefore).some(request => request.messages.some((message: any) => message.content === "native cancellable stream")), { timeout: 5000 }).toBe(true);
      await page.getByRole("button", { name: "停止生成", exact: true }).click({ timeout: 5000 });
      await expect.poll(() => cancelledModelStreams, { timeout: 5000 }).toBe(cancelledBefore + 1);
      await page.getByText("已停止", { exact: true }).first().waitFor({ timeout: 5000 });
      const parentProjection = await app.inject({ method: "POST", url: `/api/development/projects/${project.id}/native/mock/api/session/projections`, headers: { "X-API-Key": adminKey }, payload: { type: "client-request", rpcId: "branch-parent-projection", method: "session/projections", payload: { args: { request: { sessionId: developerSessionId } } } } });
      expect(parentProjection.statusCode, parentProjection.body).toBe(200);
      const parentHistory = await app.inject({ method: "POST", url: `/api/development/projects/${project.id}/native/mock/api/session/page`, headers: { "X-API-Key": adminKey }, payload: { type: "client-request", rpcId: "branch-parent-page", method: "session/page", payload: { args: { request: { address: { kind: "session", sessionId: developerSessionId }, throughSeq: parentProjection.json().result.value.asOfSeq } } } } });
      expect(parentHistory.statusCode, parentHistory.body).toBe(200);
      expect(parentHistory.body).toContain("native question finished");
      expect(parentHistory.body).not.toContain("native cancellable stream");
      await page.reload();
      await page.getByText("已停止", { exact: true }).first().waitFor({ timeout: 5000 });
      await page.getByText("轨迹", { exact: true }).click();
      await page.getByText("native developer reasoning: inspect the application manifest", { exact: false }).first().waitFor({ timeout: 5000 });
      expect(await page.locator("style[data-localapp-development-settings]").count()).toBe(1);
      await page.evaluate(() => (window as any).unloadDevelopmentClient());
      await expect.poll(() => page.getByLabel("应用开发上下文").count(), { timeout: 5000 }).toBe(0);
      expect(await page.locator("style[data-localapp-development-settings]").count()).toBe(0);
      expect(await page.getByRole("button", {name:"应用开发",exact:true}).count()).toBe(0);
      await page.getByRole("button", {name: /^(设置|Settings)$/}).click();
      expect(await page.getByRole("button", {name: "开发 Agent 能力", exact: true}).count()).toBe(0);
      expect(await page.getByRole("button", {name: "应用开发环境", exact: true}).count()).toBe(0);
      await page.keyboard.press("Escape");
      expect(await page.locator('[aria-label="轨迹工具栏"]').count()).toBe(1);
      expect(await page.getByText("native developer reasoning: inspect the application manifest", { exact: false }).first().isVisible()).toBe(true);
      await page.reload();
      await expect.poll(() => page.getByLabel("应用开发上下文").innerText(), { timeout: 10000 }).toBe("开发者模式 · native-trace-app");
      await page.getByRole("button", {name:"应用开发",exact:true}).click();
      await page.getByLabel("新文件路径",{exact:true}).fill("native-editor-check.txt");
      await page.getByRole("button",{name:"新建文件",exact:true}).click();
      await page.getByRole("combobox",{name:"源码文件",exact:true}).click();
      await page.getByRole("option",{name:"native-editor-check.txt",exact:true}).click();
      await page.getByLabel("源码内容",{exact:true}).fill("edited through the original dsh main panel");
      await page.getByRole("button",{name:"保存文件",exact:true}).click();
      await expect.poll(async()=>{
        const response=await page.request.get(`${baseUrl}/api/development/projects/${project.id}/file?path=native-editor-check.txt`);
        return (await response.json()).data.content;
      }).toBe("edited through the original dsh main panel");
      await expect.poll(async()=>{
        const response=await page.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`);
        return (await response.json()).data.some((b:any)=>["queued","running"].includes(b.status));
      },{timeout:30000}).toBe(false);
      await expect.poll(()=>page.getByRole("button",{name:"检查与构建",exact:true}).isEnabled(),{timeout:5000}).toBe(true);
      await page.getByRole("button",{name:"查看改动",exact:true}).click();
      await page.getByRole("region",{name:"源码改动"}).getByText("edited through the original dsh main panel",{exact:false}).first().waitFor();
      const restoreButton=page.getByRole("button",{name:"恢复版本",exact:true});
      await restoreButton.click();
      await page.getByRole("dialog",{name:"确认操作"}).waitFor();
      await page.keyboard.press("Escape");
      await expect.poll(()=>restoreButton.evaluate(element=>element===document.activeElement)).toBe(true);
      expect((await (await page.request.get(`${baseUrl}/api/development/projects/${project.id}/file?path=native-editor-check.txt`)).json()).data.content).toBe("edited through the original dsh main panel");
      const startedBuild=page.waitForResponse(response=>response.url()===`${baseUrl}/api/development/projects/${project.id}/builds` && response.request().method()==="POST");
      await page.getByRole("button",{name:"检查与构建",exact:true}).click();
      const buildResponse=await startedBuild;
      expect(buildResponse.status()).toBe(200);
      const startedBuildId=(await buildResponse.json()).data.id;
      await expect.poll(async()=>{
        const response=await page.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`);
        const build=(await response.json()).data.find((b:any)=>b.id===startedBuildId);
        return build && !["queued","running"].includes(build.status) ? build.status : "pending";
      },{timeout:30000}).not.toBe("pending");
      await page.getByRole("region",{name:"构建日志"}).waitFor();
      await expect.poll(()=>page.getByRole("button",{name:"取消构建",exact:true}).count(),{timeout:5000}).toBe(0);
      expect(await page.getByText("项目已有构建任务",{exact:true}).count()).toBe(0);
      const previewPopup=page.waitForEvent("popup");
      await page.getByRole("button",{name:"预览",exact:true}).click();
      const previewPage=await previewPopup;
      await previewPage.waitForLoadState("domcontentloaded");
      await previewPage.getByRole("heading",{name:"工作项",exact:true}).waitFor();
      await previewPage.close();
      await page.getByRole("button",{name:"上线",exact:true}).click();
      await page.getByRole("dialog",{name:"确认操作"}).waitFor();
      const published=page.waitForResponse(response=>response.url()===`${baseUrl}/api/development/projects/${project.id}/releases` && response.request().method()==="POST");
      await page.getByRole("button",{name:"确认",exact:true}).click();
      const publishResponse=await published;expect(publishResponse.status()).toBe(200);
      const publishedUrl=(await publishResponse.json()).data.url;
      const formalPage=await browser.newPage({extraHTTPHeaders:{"X-API-Key":adminKey}});
      expect((await formalPage.request.post(`${baseUrl}/api/auth/login`,{data:{username:"harness-http-admin",password:"harness-test-password"}})).status()).toBe(200);
      await formalPage.goto(new URL(publishedUrl,baseUrl).href);
      await formalPage.getByRole("heading",{name:"工作项",exact:true}).waitFor();
      const formalNative=formalPage.frameLocator('iframe[title="原生应用开发对话"]');
      await formalNative.locator("button").first().waitFor({state:"attached"});
      await formalNative.locator("textarea, [contenteditable=true]").first().waitFor({state:"attached"});
      const priorBuilds=(await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()).data.map((build:any)=>build.id);
      await formalPage.getByLabel("应用修改需求",{exact:true}).fill("native formal application edit");
      await formalPage.getByLabel("应用修改需求",{exact:true}).press("Enter");
      await expect.poll(async()=>{
        const builds=(await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()).data;
        return builds.some((build:any)=>!priorBuilds.includes(build.id)&&build.purpose==="preview");
      },{timeout:30000}).toBe(true).catch(async error=>{
        await fs.writeFile(path.resolve(dataDir,"..","native-auto-preview-failure.json"),JSON.stringify({body:await formalPage.locator("body").innerText(),nativeBody:await formalNative.locator("body").innerText(),builds:await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()},null,2));
        throw error;
      });
      const applicationPreview=formalPage.frameLocator('iframe[title="应用开发预览"]');
      await applicationPreview.getByRole("heading",{name:"Native edited application",exact:true}).waitFor({timeout:30000});
      const repairBaseline = (await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()).data.map((build: any) => build.id);
      const requestBaseline = modelRequests.length;
      const repairLegacyRequests: string[] = [];
      formalPage.on("request", request => { if (new URL(request.url()).pathname.endsWith("/agent/run")) repairLegacyRequests.push(request.url()); });
      await formalPage.getByLabel("应用修改需求", { exact: true }).fill("native broken preview edit");
      await formalPage.getByLabel("应用修改需求", { exact: true }).press("Enter");
      await expect.poll(async () => {
        const builds = (await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()).data;
        return builds.filter((build: any) => !repairBaseline.includes(build.id) && build.purpose === "preview" && build.status === "failed").length;
      }, { timeout: 30000 }).toBe(1);
      await expect.poll(async () => {
        const builds = (await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()).data;
        return builds.some((build: any) => !repairBaseline.includes(build.id) && build.purpose === "preview" && build.status === "succeeded");
      }, { timeout: 30000 }).toBe(true);
      const repairBuilds = (await (await formalPage.request.get(`${baseUrl}/api/development/projects/${project.id}/builds`)).json()).data;
      const failedBuild = repairBuilds.find((build: any) => !repairBaseline.includes(build.id) && build.status === "failed");
      expect(failedBuild.log).toContain("App.tsx");
      const repairPrompts = modelRequests.slice(requestBaseline).flatMap(request => request.messages).filter((message: any) => message.role === "user").map((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("") : message.content);
      expect(repairPrompts.some((prompt: string) => prompt.startsWith("平台预览编译失败（自动修复") && prompt.includes(failedBuild.log))).toBe(true);
      const messageText = (message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("") : String(message.content);
      expect(modelRequests.slice(requestBaseline).some(request =>
        request.messages.some((message: any) => message.role === "user" && messageText(message).startsWith("平台预览编译失败（自动修复")) &&
        request.messages.some((message: any) => message.role === "user" && messageText(message) === "native broken preview edit")
      )).toBe(true);
      expect(repairLegacyRequests).toEqual([]);
      await applicationPreview.getByRole("heading", { name: "Native edited application", exact: true }).waitFor({ timeout: 10000 });
      await page.getByRole("combobox",{name:"源码版本",exact:true}).click();
      await page.getByRole("option",{name:"创建项目",exact:true}).click();
      await page.getByRole("button",{name:"恢复版本",exact:true}).click();
      await page.getByRole("dialog",{name:"确认操作"}).waitFor();
      await page.getByRole("button",{name:"确认",exact:true}).click();
      await expect.poll(async()=>{
        const response=await page.request.get(`${baseUrl}/api/development/projects/${project.id}/files`);
        return (await response.json()).data.includes("native-editor-check.txt");
      }).toBe(false);
      await formalPage.reload();
      await expect.poll(()=>page.getByRole("region",{name:"源码改动"}).count()).toBe(0);
      await formalPage.getByRole("heading",{name:"工作项",exact:true}).waitFor();
      await formalPage.close();
      await page.getByRole("region",{name:"构建日志"}).scrollIntoViewIfNeeded();
      const panelArtifacts=path.resolve(dataDir,"..","browser-evidence");await fs.mkdir(panelArtifacts,{recursive:true});
      await page.screenshot({path:path.join(panelArtifacts,"developer-native-project-panel.png")});
      await page.getByRole("button",{name:"返回开发对话",exact:true}).click();
      await page.getByText("native developer reasoning: inspect the application manifest",{exact:false}).first().waitFor();
      const settingsButton = page.getByRole("button", { name: /^(设置|Settings)$/ });
      await settingsButton.click();
      await page.getByRole("button", { name: "开发 Agent 能力", exact: true }).click();
      const developerSettings = page.locator(".localapp-native-settings");
      await developerSettings.getByLabel("禁用工具", { exact: true }).fill("web_fetch");
      await developerSettings.getByRole("button", { name: "保存", exact: true }).click();
      await developerSettings.getByText("开发 Agent 设置已保存", { exact: true }).waitFor();
      const savedPreferences = await page.request.get(`${baseUrl}/api/development/projects/${project.id}/agent/settings`);
      expect((await savedPreferences.json()).data.disabledTools).toEqual(["web_fetch"]);
      const settingsArtifacts = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(settingsArtifacts, {recursive: true});
      await page.screenshot({path: path.join(settingsArtifacts, "developer-native-settings.png")});
      await page.getByRole("button",{name:"应用开发环境",exact:true}).click();
      await page.getByLabel("模板依赖目录",{exact:true}).waitFor();
      await page.getByText(/^Node .*基础环境已就绪$/).waitFor({timeout:15000});
      await page.screenshot({path:path.join(settingsArtifacts,"developer-native-environment.png")});
      await page.keyboard.press("Escape");
      await developerSettings.waitFor({state: "hidden"});
      await expect.poll(() => settingsButton.evaluate(element => element === document.activeElement)).toBe(true);
      expect((await page.request.post(`${baseUrl}/api/auth/login`,{data:{username:"harness-http-admin",password:"harness-test-password"}})).status()).toBe(200);
      await page.goto(`${baseUrl}/my/development?projectId=${encodeURIComponent(project.id)}`);
      const workspaceFrame=page.frameLocator('iframe[title="原生应用开发工作区"]');
      await workspaceFrame.getByRole("button",{name:"应用开发",exact:true}).click({timeout:15000});
      await workspaceFrame.getByLabel("新文件路径",{exact:true}).waitFor();
      await page.getByRole("combobox",{name:"开发模型",exact:true}).click();
      await page.getByRole("option",{name:"Mock · mock-model",exact:true}).waitFor();
      await page.keyboard.press("Escape");
      await expect.poll(()=>page.getByRole("combobox",{name:"开发模型",exact:true}).evaluate(element=>element===document.activeElement)).toBe(true);
      await page.screenshot({path:path.join(settingsArtifacts,"native-development-entry.png")});
      expect(errors).toEqual([]);
    } finally {
      const artifacts=path.resolve(dataDir,"..","browser-evidence");await fs.mkdir(artifacts,{recursive:true});
      await page.screenshot({path:path.join(artifacts,"developer-native.png"),fullPage:true});
      await fs.writeFile(path.join(artifacts,"developer-native.json"),JSON.stringify({errors,questionWire,text:await page.locator("body").innerText(),questions:modelRequests.filter(request=>request.messages.some((message:any)=>message.content==="native developer question"))},null,2));
      await browser.close();
    }
  },90000);
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("boots the original native client in a real browser", async () => {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ extraHTTPHeaders: { "X-API-Key": adminKey } });
    const errors: string[] = [];
    const failures: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    try {
      await page.goto(`${baseUrl}/api/agent/native/${scope}/`, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.locator("textarea, [contenteditable=true]").first().waitFor({ timeout: 5000 });
      const input = page.locator("textarea, [contenteditable=true]").first();
      await input.fill("native HTTP hello", { timeout: 5000 });
      await input.press("Enter", { timeout: 5000 });
      await page.getByText("native HTTP finished", { exact: true }).first().waitFor({ timeout: 5000 });
      await page.getByText("轨迹", { exact: true }).click({ timeout: 5000 });
      await page.locator('[aria-label="轨迹工具栏"]').waitFor({ timeout: 5000 });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });
      await page.getByText("native HTTP finished", { exact: true }).first().waitFor({ timeout: 5000 });
      await page.locator('[aria-label="轨迹工具栏"]').waitFor({ timeout: 5000 });
      const moreSessions=page.getByText(/展开其余.*会话/);
      if(await moreSessions.isVisible()) await moreSessions.click();
      await page.getByText("echo hello", { exact: true }).click({ timeout: 5000 });
      await page.getByText("工具已完成", { exact: true }).first().waitFor({ timeout: 5000 });
      await page.getByText("轨迹", { exact: true }).click({ timeout: 5000 });
      await page.locator('[aria-label="轨迹工具栏"]').waitFor({ timeout: 5000 });
      await page.getByText("echo", { exact: true }).first().waitFor({ timeout: 5000 });
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      const artifacts = path.resolve(dataDir, "..", "browser-evidence");
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "native-boot.png"), fullPage: true });
      await fs.writeFile(path.join(artifacts, "native-boot.json"), JSON.stringify({ errors, failures, text: await page.locator("body").innerText() }, null, 2));
      await browser.close();
    }
  }, 25000);
  it("rejects unauthenticated, inaccessible and foreign-origin native sockets", async () => {
    const status = (headers: Record<string, string>, query = "") => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/api/remote.mux" + query, { headers });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("Socket rejection timed out")); }, 5000);
      socket.once("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.once("error", () => {});
      socket.once("open", () => { clearTimeout(timer); socket.terminate(); reject(new Error("Unauthorized socket opened")); });
    });
    expect(await status({})).toBe(401);
    expect(await status({ "X-API-Key": adminKey }, "?appId=missing/application")).toBe(400);
    expect(await status({ "X-API-Key": adminKey, Origin: "https://untrusted.test" })).toBe(403);
  });
  it("establishes the native client forwarded-event stream", async () => {
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/api/remote.mux", { headers: { "X-API-Key": adminKey } });
    try {
      const frame = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native client readiness timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.once("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "client-events", endpoint: "$events", payload: { args: {} } })));
      });
      expect(frame.type).toBe("item");
      expect(frame.value.type).toBe("ready");
      expect(frame.value.clientId).toEqual(expect.any(String));
    } finally { socket.terminate(); }
  });
  it("follows native trajectory through the unified Server WebSocket", async () => {
    const sessionId = "websocket-trajectory-session";
    const initial = await fetch(baseUrl + "/api/agent/run", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, prompt: "native HTTP hello", systemPrompt: "", tools: [] }) });
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain("native HTTP finished");
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/" + scope + "/api/remote.mux", { headers: { "X-API-Key": adminKey } });
    try {
      const frame = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native trajectory socket timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "history", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
      });
      expect(JSON.stringify(frame)).toContain("native HTTP hello");
      expect(JSON.stringify(frame)).toContain("request/header");
      const update = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live trajectory update timed out")), 5000);
        socket.on("message", value => { const text = value.toString(); if (text.includes("live trajectory update")) { clearTimeout(timer); resolve(text); } });
      });
      const turn = await fetch(baseUrl + "/api/agent/run", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, prompt: "live trajectory update", systemPrompt: "", tools: [] }) });
      expect(turn.status).toBe(200); await turn.text();
      expect(await update).toContain("agent/inbox/spliced");
      socket.send(JSON.stringify({ type: "cancel", streamId: "history" }));
    } finally { socket.terminate(); }
  });
  it("keeps provider credentials and settings separate for each user", async () => {
    const get = (key: string) => app.inject({ method: "GET", url: "/api/agent/settings", headers: { "X-API-Key": key } });
    const own = (await get(adminKey)).json();
    expect(own.data.providers[0].hasApiKey).toBe(true);
    expect(JSON.stringify(own)).not.toContain("mock-key");
    expect((await get(outsiderKey)).json().data.providers).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/agent/run", headers: { "X-API-Key": outsiderKey }, payload: { sessionId: "not-configured", prompt: "hi", systemPrompt: "", tools: [] } })).statusCode).toBe(400);
    const saved = await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": outsiderKey }, payload: { ...own.data, providers: [{ ...own.data.providers[0], model: "outsider-model", apiKey: "test-outsider-model-key" }] } });
    expect(saved.statusCode).toBe(200);
    const response = await fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "X-API-Key": outsiderKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "http-e2e-session", prompt: "hello", systemPrompt: "", tools: [] }) });
    expect(response.status).toBe(200);
    // With no echo tool registered the loop records its unknown-tool error;
    // the provider still completes the next model step and the turn settles.
    await response.text();
    expect(modelRequests.at(-1).model).toBe("outsider-model");
    expect(modelRequests.at(-1).authorization).toBe("Bearer test-outsider-model-key");
    expect((await get(adminKey)).json().data.providers[0].model).toBe("mock-model");
    expect((await app.inject({ method: "GET", url: "/api/agent/sessions", headers: { "X-API-Key": adminKey } })).json().data.map((s: any) => s.id)).toContain("http-e2e-session");
  });
  it("requires both application declarations and user grants before exposing extra tools", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const directory = path.join(dataDir, owner.id, "agent-app");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name: "agent-app", userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "owner" } }));
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name: "agent-app", agent: { capabilities: ["files", "subagents"] } }));
    const own = (await app.inject({ method: "GET", url: "/api/agent/settings", headers: { "X-API-Key": adminKey } })).json().data;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { ...own, grants: { "harness-http-admin/agent-app": ["files", "terminal"] } } })).statusCode).toBe(200);
    const input = { appId: "harness-http-admin/agent-app", sessionId: "declared-capabilities", prompt: "hello", systemPrompt: "Application prompt", tools: [] };
    const response = await fetch(`${baseUrl}/api/agent/run`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    await response.text();
    const names = modelRequests.at(-1).tools.map((t: any) => t.function.name);
    expect(names).toContain("read");
    expect(names).not.toContain("subagent");
    expect(names).not.toContain("bash");
    expect(modelRequests.at(-1).authorization).toBe("Bearer mock-key");
    expect((await app.inject({ method: "POST", url: "/api/agent/run", headers: { "X-API-Key": outsiderKey }, payload: input })).statusCode).toBe(400);
  });

  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("loads the original schedule UI only when the application and user enable it", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const directory = path.join(dataDir, owner.id, "schedule-app");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name: "schedule-app", userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "owner" } }));
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name: "schedule-app", agent: { capabilities: ["schedule"] } }));
    const appId = "harness-http-admin/schedule-app";
    const scope = Buffer.from(JSON.stringify({ appId, providerId: "mock" })).toString("base64url");
    const url = `/api/agent/native/${scope}/`;
    const disabled = await app.inject({ url, headers: { "X-API-Key": adminKey } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.body).not.toContain("@deepseek-ai/dsh-client-ui-schedule");
    const disabledCatalog = await app.inject({ method: "POST", url: url + "api/schedule/catalog", headers: { "X-API-Key": adminKey }, payload: { type: "client-request", rpcId: "disabled-schedule", method: "schedule/catalog", payload: { args: {} } } });
    expect(disabledCatalog.statusCode).toBe(404);
    const own = (await app.inject({ url: "/api/agent/settings", headers: { "X-API-Key": adminKey } })).json().data;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { ...own, grants: { ...own.grants, [appId]: ["schedule"] } } })).statusCode).toBe(200);
    const enabled = await app.inject({ url, headers: { "X-API-Key": adminKey } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.body).toContain("@deepseek-ai/dsh-client-ui-schedule");
    const turn = await fetch(baseUrl + "/api/agent/run", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ appId, providerId: "mock", sessionId: "native-schedule-session", prompt: "native schedule create", systemPrompt: "", tools: [] }) });
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain("native schedule created");
    for (const method of ["catalog"]) {
      const response = await app.inject({ method: "POST", url: url + "api/schedule/" + method, headers: { "X-API-Key": adminKey }, payload: { type: "client-request", rpcId: "schedule-" + method, method: "schedule/" + method, payload: { args: {} } } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().result.ok, response.body).toBe(true);
      expect(response.json().result.value).toEqual([expect.objectContaining({ title: "Native schedule marker", sessionId: "native-schedule-session" })]);
    }
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ extraHTTPHeaders: { "X-API-Key": adminKey } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await page.goto(baseUrl + url);
      await page.getByText("自动化任务", { exact: true }).first().waitFor({ timeout: 10000 });
      await page.getByText("自动化任务", { exact: true }).first().click();
      await page.getByRole("button", { name: "Native schedule marker", exact: true }).click({ timeout: 10000 });
      await page.getByRole("button", { name: "自动化任务操作", exact: true }).click();
      await page.getByText("删除任务", { exact: true }).click();
      await page.getByRole("button", { name: "确认删除", exact: true }).click();
      await page.getByText("任务已删除", { exact: true }).first().waitFor({ timeout: 5000 });
      const removed = await app.inject({ method: "POST", url: url + "api/schedule/catalog", headers: { "X-API-Key": adminKey }, payload: { type: "client-request", rpcId: "deleted-schedule", method: "schedule/catalog", payload: { args: {} } } });
      expect(removed.json().result.value).toEqual([]);
      const foreign = await app.inject({ method: "POST", url: url + "api/schedule/catalog", headers: { "X-API-Key": outsiderKey }, payload: { type: "client-request", rpcId: "foreign-schedule", method: "schedule/catalog", payload: { args: {} } } });
      expect(foreign.statusCode).toBe(400);
      expect(foreign.body).not.toContain("Native schedule marker");
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 30000);
  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1")("observes and cancels a real background command from the original jobs UI", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const directory = path.join(dataDir, owner.id, "background-app");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name: "background-app", userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "owner" } }));
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name: "background-app", agent: { capabilities: ["terminal", "jobs"] } }));
    const appId = "harness-http-admin/background-app";
    const own = (await app.inject({ url: "/api/agent/settings", headers: { "X-API-Key": adminKey } })).json().data;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { ...own, grants: { ...own.grants, [appId]: ["terminal", "jobs"] } } })).statusCode).toBe(200);
    const turn = await fetch(baseUrl + "/api/agent/run", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ appId, providerId: "mock", sessionId: "native-background-session", prompt: "native background command", systemPrompt: "", tools: [] }) });
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain("native background started");
    const scope = Buffer.from(JSON.stringify({ appId, providerId: "mock" })).toString("base64url");
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ extraHTTPHeaders: { "X-API-Key": adminKey } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(baseUrl + `/api/agent/native/${scope}/`);
      await page.getByText("native background command", { exact: true }).first().click({ timeout: 10000 });
      await page.getByRole("button", { name: "1 个后台任务运行中", exact: true }).click({ timeout: 5000 });
      await page.getByRole("button", { name: /展开 .* 的实时输出/ }).click({ timeout: 5000 });
      await page.getByText("native-background-output", { exact: false }).first().waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: /^停止任务 / }).click({ timeout: 5000 });
      await page.getByRole("button", { name: "再次点击确认停止", exact: true }).click({ timeout: 5000 });
      await page.getByText("signal: SIGTERM; cancelled by the user", { exact: true }).first().waitFor({ timeout: 5000 });
      await page.getByText("已结束 1", { exact: true }).waitFor({ timeout: 5000 });
      expect(await page.getByRole("button", { name: "1 个后台任务运行中", exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
      const artifacts = path.resolve(dataDir, "..", "browser-evidence");
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "native-background-job.png"), fullPage: true });
    } finally { await browser.close(); }
  }, 30000);

  it("restores legacy history and live native trajectory after runtime invalidation", async () => {
    const rpc = (method: string, args: unknown) => fetch(`${baseUrl}/api/agent/native/api/session/${method}`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "restore-" + method, method: "session/" + method, payload: { args } }) });
    expect((await (await rpc("rename", { request: { sessionId: "http-e2e-session", title: "Restored conversation name" } })).json()).result.ok).toBe(true);
    const saved = (await app.inject({ url: "/api/agent/settings", headers: { "X-API-Key": adminKey } })).json().data;
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: saved })).statusCode).toBe(200);
    const owner = findUserByName("harness-http-admin")!;
    const runtimeRoot = path.join(dataDir, "agent", createHash("sha256").update(JSON.stringify([owner.id, "platform", "mock"])).digest("hex"));
    await fs.rm(path.join(runtimeRoot, "storage", "session_projcache"), { recursive: true, force: true });
    const modelCount = modelRequests.length;
    const listed = (await (await rpc("list", { _request: {} })).json()).result;
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    expect(listed.value.items.find((session: any) => session.sessionId === "http-e2e-session")?.projections?.values?.title).toBe("Restored conversation name");
    expect(listed.value.items.find((session: any) => session.sessionId === "http-e2e-session")?.agentAvailable).toBe(false);
    expect(modelRequests).toHaveLength(modelCount);
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "mock" })).toString("base64url");
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/api/agent/native/" + scope + "/api/remote.mux", { headers: { "X-API-Key": adminKey } });
    try {
      const frame = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native trajectory socket timed out")), 5000);
        socket.once("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
        socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "history", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: "http-e2e-session" } } } } })));
      });
      expect(JSON.stringify(frame)).toContain("echo hello");
      expect(JSON.stringify(frame)).toContain("request/header");
      let turnWire = "";
      const update = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live trajectory update timed out: " + turnWire)), 5000);
        socket.on("message", value => { const text = value.toString(); if (text.includes("live trajectory update")) { clearTimeout(timer); resolve(text); } });
      });
      const turn = await fetch(baseUrl + "/api/agent/run", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "http-e2e-session", prompt: "live trajectory update", systemPrompt: "", tools: [] }) });
      expect(turn.status).toBe(200); turnWire = await turn.text();
      expect(await update).toContain("agent/inbox/spliced");
      socket.send(JSON.stringify({ type: "cancel", streamId: "history" }));
    } finally { socket.terminate(); }
  });

  it.runIf(process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1" && testCombination === "full")("saves developer settings from the formal application dialog", async () => {
    const owner = findUserByName("harness-http-admin")!, name = "developer-settings-browser";
    const directory = path.join(dataDir, owner.id, name), version = path.join(directory, "versions", "v1");
    await fs.mkdir(version, { recursive: true });
    await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name, userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "owner" } }));
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name }));
    await fs.writeFile(path.join(version, "index.html"), "<!doctype html><html><body><h1>Developer settings application</h1></body></html>");
    const created = await app.inject({ method: "POST", url: "/api/development/projects", headers: { "X-API-Key": adminKey }, payload: { name } });
    expect(created.statusCode, created.body).toBe(201);
    const projectId = created.json().data.id;
    const { chromium } = await import("@playwright/test"), browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      expect((await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-http-admin", password: "harness-test-password" } })).status()).toBe(200);
      await page.goto(baseUrl + `/harness-http-admin/${name}/`);
      const trigger = page.getByRole("button", { name: "开发 Agent 设置", exact: true });
      await trigger.waitFor({ timeout: 10000 }); await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("switch", { name: "终端命令" }).waitFor();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      const terminal = dialog.getByRole("switch", { name: "终端命令" });
      await terminal.focus(); await page.keyboard.press("Space");
      expect(await terminal.getAttribute("aria-checked")).toBe("false");
      await dialog.getByLabel("禁用工具", { exact: true }).fill("write\nbash");
      const artifacts = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "developer-settings-dialog.png") });
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const saved = await page.request.get(baseUrl + `/api/development/projects/${projectId}/agent/settings`);
      const preferences = (await saved.json()).data;
      expect(preferences.enabledCapabilities).not.toContain("terminal"); expect(preferences.disabledTools).toEqual(["write", "bash"]);
      await trigger.click(); await dialog.getByRole("switch", { name: "终端命令" }).waitFor();
      expect(await dialog.getByRole("switch", { name: "终端命令" }).getAttribute("aria-checked")).toBe("false");
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await expect.poll(() => trigger.evaluate(element => element === document.activeElement), { timeout: 3000 }).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      await trigger.click(); await dialog.getByRole("switch", { name: "终端命令" }).waitFor();
      await dialog.getByLabel("禁用工具", { exact: true }).fill(Array.from({ length: 100 }, (_, index) => "mcp__project__tool_" + index).join("\n"));
      const mobileBounds = await dialog.boundingBox();
      expect(mobileBounds!.x).toBeGreaterThanOrEqual(0); expect(mobileBounds!.y).toBeGreaterThanOrEqual(0);
      expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390); expect(mobileBounds!.y + mobileBounds!.height).toBeLessThanOrEqual(844);
      await dialog.getByRole("button", { name: "保存", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, "developer-settings-mobile.png") });
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(baseUrl + `/my/development?projectId=${projectId}`);
      const standaloneFrame=page.frameLocator('iframe[title="原生应用开发工作区"]');
      const fullTrigger = standaloneFrame.getByRole("button", { name: /^(设置|Settings)$/ });
      await fullTrigger.waitFor({ timeout: 10000 }); await fullTrigger.click();
      await standaloneFrame.getByRole("button",{name:"开发 Agent 能力",exact:true}).click();
      const nativeSettings=standaloneFrame.locator(".localapp-native-settings");
      await nativeSettings.getByRole("switch", { name: "终端命令" }).waitFor();
      expect(await nativeSettings.getByRole("switch", { name: "终端命令" }).getAttribute("aria-checked")).toBe("false");
      expect(await nativeSettings.getByLabel("禁用工具", { exact: true }).inputValue()).toBe("write\nbash");
      await page.screenshot({ path: path.join(artifacts, "developer-settings-full-page.png") });
      await page.keyboard.press("Escape"); await nativeSettings.waitFor({ state: "hidden" });
      const restores: string[] = [];
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/restore")) restores.push(request.url()); });
      await standaloneFrame.getByRole("button", { name: "应用开发", exact: true }).click();
      const restore = standaloneFrame.getByRole("button", { name: "恢复版本", exact: true });
      await restore.click();
      const confirmation = standaloneFrame.getByRole("dialog", { name: "确认操作", exact: true });
      await confirmation.waitFor();
      await page.screenshot({ path: path.join(artifacts, "development-restore-confirmation.png") });
      expect(restores).toEqual([]);
      await page.keyboard.press("Escape"); await confirmation.waitFor({ state: "hidden" });
      await expect.poll(() => restore.evaluate(element => element === document.activeElement)).toBe(true);
      expect(restores).toEqual([]);
      await restore.click(); await confirmation.waitFor();
      await confirmation.getByRole("button", { name: "确认", exact: true }).click();
      await expect.poll(() => restores.length).toBe(1);
      await confirmation.waitFor({ state: "hidden" });
    } finally { await browser.close(); }
  }, 30000);
  it("lets an ordinary application user execute native SDK tools with their own provider but denies developer access", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const name = "ordinary-native-app";
    const directory = path.join(dataDir, owner.id, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name, userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "authenticated" } }));
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name, agent: { capabilities: [] } }));
    const version = path.join(directory, "versions", "v1");
    await fs.mkdir(path.join(version, "assets"), { recursive: true });
    await fs.writeFile(path.join(version, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>');
    await fs.writeFile(path.join(version, "assets", "main.js"), 'document.getElementById("root").innerHTML="<h1>Ordinary application ready</h1>";globalThis.__localapp_platform_tool_registry__.registerTools([{name:"echo",description:"Application echo",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]}}],{echo:()=>"ordinary formal browser marker"},"Ordinary browser application prompt");');
    const ownSettings = await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": outsiderKey }, payload: { providers: [{ id: "ordinary", name: "Ordinary", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "ordinary-model", apiKey: "ordinary-private-key" }], defaultProviderId: "ordinary", grants: {}, mcpServers: [] } });
    expect(ownSettings.statusCode).toBe(200);
    const createProtectedProject = await fetch(baseUrl + "/api/development/projects", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ name: "ordinary-protected-source" }) });
    expect(createProtectedProject.status).toBe(testCombination === "full" ? 201 : 404);
    const project = testCombination === "full" ? (await createProtectedProject.json()).data : { id: "disabled-development-project" };
    const originalFetch = globalThis.fetch;
    const { HarnessAgent } = await import("../../../sdk-agent/src/harness-client.js");
    globalThis.fetch = (input, init) => { const headers = new Headers(init?.headers); headers.set("X-API-Key", outsiderKey); return originalFetch(input, { ...init, headers }); };
    const agent = new HarnessAgent({ proxyUrl: baseUrl, appId: "harness-http-admin/" + name, initialState: { systemPrompt: "Ordinary application prompt marker" } });
    agent.providerId = "ordinary";
    let executions = 0;
    agent.state.tools = [{ name: "echo", description: "Application tool", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async () => { executions++; return { content: [], details: { echo: "ordinary native tool marker" } }; } }];
    try {
      const connected = await agent.connectNativeSession();
      const response = await originalFetch(connected.url + "api/session/prompt", { method: "POST", headers: { "X-API-Key": outsiderKey, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "ordinary-prompt", method: "session/prompt", payload: { args: { request: { sessionId: connected.sessionId, requestId: "ordinary-native-request", mode: "queue", content: [{ type: "text", text: "ordinary application echo" }] } } } }) });
      expect((await response.json()).result.value).toEqual({ accepted: true });
      await expect.poll(() => modelRequests.some(item => item.model === "ordinary-model" && item.messages.some((message: any) => message.role === "tool" && JSON.stringify(message).includes("ordinary native tool marker"))), { timeout: 5000 }).toBe(true);
      expect(executions).toBe(1);
      const request = modelRequests.filter(item => item.model === "ordinary-model").at(-1);
      expect(request.authorization).toBe("Bearer ordinary-private-key");
      expect(JSON.stringify(request.messages)).toContain("Ordinary application prompt marker");
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("write");
      const denied = await originalFetch(baseUrl + `/api/development/projects/${project.id}/native/mock/api/session/list`, { method: "POST", headers: { "X-API-Key": outsiderKey, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "denied", method: "session/list", payload: { args: { _request: {} } } }) });
      expect(denied.status).toBe(404);
      const history = await originalFetch(baseUrl + `/api/agent/sessions/${connected.sessionId}?appId=harness-http-admin/${name}&providerId=ordinary`, { headers: { "X-API-Key": adminKey } });
      expect(history.status).toBe(404);
      expect(await history.text()).not.toContain("ordinary native tool marker");
      if (process.env.LOCALAPP_NATIVE_BROWSER_VERIFY === "1") {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ channel: "chrome", headless: true });
        const page = await browser.newPage();
        page.setDefaultTimeout(5000);
        const ordinaryErrors: string[] = [];
        page.on("pageerror", error => ordinaryErrors.push(error.message));

        try {
          const login = await page.request.post(baseUrl + "/api/auth/login", { data: { username: "harness-outsider", password: "ordinary-browser-password" } });
          expect(login.status()).toBe(200);
          await page.goto(baseUrl + "/harness-http-admin/" + name + "/");
          await page.getByText("Ordinary application ready", { exact: true }).waitFor({ timeout: 10000 });
          await page.getByRole("button", { name: "展开应用对话", exact: true }).click();
          const frame = page.frameLocator('iframe[title="原生应用用户对话"]');
          const input = frame.locator("textarea, [contenteditable=true]").first();
          await input.fill("ordinary formal browser echo"); await input.press("Enter");
          await frame.getByText("工具已完成", { exact: true }).first().waitFor({ timeout: 10000 });
          expect(await page.getByRole("button", { name: "切换对话身份" }).count()).toBe(0);
          await page.getByRole("button", { name: "最小化应用对话", exact: true }).click();
          const restore = page.getByRole("button", { name: "恢复应用对话", exact: true });
          await restore.waitFor();
          expect(await restore.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))).toEqual({ width: 44, height: 44 });
          await restore.hover();
          await page.getByRole("tooltip").waitFor();
          expect(await page.getByRole("tooltip").innerText()).toContain("工具已完成");
          await page.screenshot({path: path.join(path.resolve(dataDir, "..", "browser-evidence"), "ordinary-minimized-reply-042.png"), fullPage: true});
          await restore.click();
          await page.getByRole("button", { name: "最小化应用对话", exact: true }).waitFor();
          await frame.getByText("轨迹", { exact: true }).click();
          await frame.getByText("ordinary formal browser marker", { exact: false }).first().waitFor({ timeout: 5000 });
          const applicationSettings = frame.getByRole("button", { name: /^(设置|Settings)$/ });
          await applicationSettings.click();
          expect(await frame.getByRole("button", {name: "Python 环境", exact: true}).count()).toBe(0);
          expect((await page.request.get(baseUrl + "/api/system/python-environment")).status()).toBe(403);
          await frame.getByRole("button", {name: "模型与 MCP", exact: true}).click();
          await expect.poll(() => frame.getByLabel("模型名称", {exact: true}).inputValue()).toBe("ordinary-model");
          expect(await frame.getByLabel("API Key", {exact: true}).inputValue()).toBe("");
          await frame.getByRole("button", { name: "应用 Agent 能力", exact: true }).click();
          const capabilityPanel = frame.locator(".localapp-native-settings");
          await capabilityPanel.getByText("为你在此应用中的 Agent 选择能力和工具。", { exact: true }).waitFor();
          await capabilityPanel.getByText("应用尚未声明 Agent 扩展能力。", { exact: true }).waitFor();
          expect(await capabilityPanel.getByRole("switch", { name: "PDF", exact: true }).isDisabled()).toBe(true);
          await capabilityPanel.getByRole("button", { name: "保存 Agent 设置", exact: true }).click();
          await capabilityPanel.getByText("Agent 设置已保存", { exact: true }).waitFor();
          await page.screenshot({path: path.join(path.resolve(dataDir, "..", "browser-evidence"), "ordinary-native-settings.png"), fullPage: true});
          await page.keyboard.press("Escape");
          await capabilityPanel.waitFor({state: "hidden"});
          await expect.poll(() => applicationSettings.evaluate(element => element === document.activeElement)).toBe(true);
          const compactRequests: string[] = [];
          page.on("request", request => compactRequests.push(request.url()));
          const closedBefore = cancelledModelStreams;
          await page.getByRole("button", {name: "收起应用对话", exact: true}).click();
          const compactInput = page.getByLabel("应用对话消息", {exact:true});
          await compactInput.fill("native cancellable stream"); await compactInput.press("Enter");
          await expect.poll(() => modelRequests.some(request => request.model === "ordinary-model" && request.messages.some((message:any) => message.content === "native cancellable stream")), {timeout:10000}).toBe(true);
          await page.getByRole("button", {name: "停止对话", exact: true}).waitFor({timeout:5000});
          await page.getByRole("button", {name: "停止对话", exact: true}).click();
          await expect.poll(() => cancelledModelStreams, {timeout:5000}).toBe(closedBefore + 1);
          await page.getByRole("button", {name: "发送对话消息", exact: true}).waitFor({timeout:5000});
          expect(compactRequests.some(url => url.includes("/session/prompt"))).toBe(true);
          expect(compactRequests.some(url => url.includes("/api/agent/run"))).toBe(false);
          const freshName = name + "-first-send";
          const freshDirectory = path.join(dataDir, owner.id, freshName);
          await fs.cp(directory, freshDirectory, {recursive:true});
          const freshMeta = JSON.parse(await fs.readFile(path.join(freshDirectory,"meta.json"),"utf8"));
          freshMeta.name=freshName;
          await fs.writeFile(path.join(freshDirectory,"meta.json"),JSON.stringify(freshMeta));
          const freshManifest=JSON.parse(await fs.readFile(path.join(freshDirectory,"manifest.json"),"utf8"));
          freshManifest.name=freshName;
          await fs.writeFile(path.join(freshDirectory,"manifest.json"),JSON.stringify(freshManifest));
          await page.goto(baseUrl + "/harness-http-admin/" + freshName + "/");
          await page.getByText("Ordinary application ready", {exact:true}).waitFor();
          const freshFrame=page.frameLocator('iframe[title="原生应用用户对话"]');
          const nativeSource=await page.locator('iframe[title="原生应用用户对话"]').getAttribute("src");
          const nativeResponse=await page.request.get(baseUrl+nativeSource);
          await fs.writeFile(path.resolve(dataDir,"..","fresh-native-response.txt"),JSON.stringify({nativeSource,status:nativeResponse.status(),body:await nativeResponse.text()}));
          expect(nativeResponse.status()).toBe(200);
          await freshFrame.locator("button").first().waitFor({state:"attached",timeout:10000});
          const freshRequestsStart=compactRequests.length;
          await page.getByLabel("应用对话消息",{exact:true}).fill("ordinary formal browser echo");
          await page.getByRole("button",{name:"发送对话消息",exact:true}).click();
          await page.getByRole("button",{name:"展开应用对话",exact:true}).click();
          await freshFrame.getByText("工具已完成",{exact:true}).first().waitFor({timeout:10000});
          const firstSendRequests=compactRequests.slice(freshRequestsStart);
          expect(firstSendRequests.some(url=>url.includes("/session/prompt"))).toBe(true);
          expect(firstSendRequests.some(url=>url.includes("/api/agent/run"))).toBe(false);
          const freshList=await page.request.post(baseUrl+nativeSource!.split("?")[0]+"api/session/list",{data:{type:"client-request",rpcId:"attachment-current-list",method:"session/list",payload:{args:{_request:{}}}}});
          const freshSession=(await freshList.json()).result.value.items[0];
          const freshSessionId=freshSession.sessionId??freshSession.id;
          const nativeUploads: any[]=[];
          await page.route("**/uploadFileBinary?*",async route=>{
            const response=await route.fetch();
            nativeUploads.push(await response.json());
            await route.fulfill({response});
          });
          const uploaded=page.waitForResponse(response=>response.url().includes("uploadFileBinary")&&response.request().method()==="POST");
          await page.getByRole("button",{name:"收起应用对话",exact:true}).click();
          const picker=page.waitForEvent("filechooser");
          await page.getByRole("button",{name:"上传文件",exact:true}).click();
          await (await picker).setFiles({name:"native-intake.pdf",mimeType:"application/pdf",buffer:Buffer.from([0x25,0x50,0x44,0x46,0,0xff,0x80,0x0a])});
          const uploadedResponse=await uploaded;
          expect(uploadedResponse.status()).toBe(200);
          expect(nativeUploads[0]).toMatchObject({ok:true,value:{file:{name:"native-intake.pdf",bytes:8}}});
          expect(new URL(uploadedResponse.url()).searchParams.get("sessionId")).toBe(freshSessionId);
          await page.getByRole("button",{name:"展开应用对话",exact:true}).click();
          await freshFrame.getByText("native-intake.pdf",{exact:true}).first().waitFor();
          await freshFrame.getByText("PDF 8B",{exact:true}).first().waitFor();
          await page.getByLabel("待发送附件",{exact:true}).getByText("native-intake.pdf",{exact:true}).waitFor();
          await page.getByRole("button",{name:"移除附件 native-intake.pdf",exact:true}).click();
          await freshFrame.getByText("native-intake.pdf",{exact:true}).first().waitFor({state:"hidden"});
          await page.getByLabel("待发送附件",{exact:true}).waitFor({state:"hidden"});
          expect(ordinaryErrors).toEqual([]);
          const artifacts = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(artifacts, { recursive: true });
          await page.screenshot({ path: path.join(artifacts, "ordinary-formal-app" + (testCombination === "platform" ? "-platform" : "") + ".png"), fullPage: true });
        } finally {
          const artifacts = path.resolve(dataDir, "..", "browser-evidence"); await fs.mkdir(artifacts, { recursive: true });
          await page.screenshot({ path: path.join(artifacts, "ordinary-formal-debug.png"), fullPage: true });
          await browser.close();
        }
      }

    } finally { agent.dispose(); globalThis.fetch = originalFetch; }
  }, 45000);

  it("isolates native lists search and pages between two configured users", async () => {
    const settings = { providers: [{ id: "isolation", name: "Isolation", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "isolation-model", apiKey: "isolation-key" }], defaultProviderId: "isolation", grants: {}, mcpServers: [] };
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "isolation" })).toString("base64url");
    const rpc = async (key: string, method: string, args: unknown) => {
      const response = await fetch(`${baseUrl}/api/agent/native/${scope}/api/session/${method}`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "isolation-" + method, method: "session/" + method, payload: { args } }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const sessions: Array<{key: string; sessionId: string; marker: string}> = [];
    for (const [key, marker] of [[adminKey, "configured-owner-private-marker"], [outsiderKey, "configured-outsider-private-marker"]]) {
      expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": key }, payload: settings })).statusCode).toBe(200);
      const created = await rpc(key, "create", { request: {} });
      const sessionId = created.result.value.sessionId;
      await rpc(key, "rename", { request: { sessionId, title: marker } });
      expect((await rpc(key, "prompt", { request: { sessionId, requestId: marker, mode: "queue", content: [{ type: "text", text: marker }] } })).result.value.accepted).toBe(true);
      await expect.poll(async () => {
        const history = await fetch(baseUrl + `/api/agent/sessions/${sessionId}?providerId=isolation`, { headers: { "X-API-Key": key } });
        return (await history.text()).includes("工具已完成");
      }, { timeout: 5000 }).toBe(true);
      sessions.push({ key, sessionId, marker });
    }
    for (const own of sessions) {
      const other = sessions.find(row => row !== own)!;
      const list = JSON.stringify(await rpc(own.key, "list", { _request: {} }));
      expect(list).toContain(own.sessionId); expect(list).not.toContain(other.sessionId);
      const searchOwn = JSON.stringify(await rpc(own.key, "search", { request: { query: own.marker } }));
      expect(searchOwn).toContain(own.marker);
      const searchForeign = JSON.stringify(await rpc(own.key, "search", { request: { query: other.marker } }));
      expect(searchForeign).not.toContain(other.sessionId);
      const foreign = JSON.stringify(await rpc(own.key, "page", { request: { address: { kind: "session", sessionId: other.sessionId }, throughSeq: 0 } }));
      expect(foreign).not.toContain(other.marker); expect(foreign).not.toContain("工具已完成");
      const socket = new WebSocket(baseUrl.replace("http:", "ws:") + `/api/agent/native/${scope}/api/remote.mux`, { headers: { "X-API-Key": own.key } });
      try {
        const denied = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Foreign native subscription did not terminate")), 5000);
          socket.once("error", error => { clearTimeout(timer); reject(error); });
          socket.on("message", frame => { const value = JSON.parse(frame.toString()); if (["end", "error"].includes(value.type)) { clearTimeout(timer); resolve(frame.toString()); } else if (frame.toString().includes(other.marker)) { clearTimeout(timer); reject(new Error("Foreign trajectory leaked")); } });
          socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "foreign", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: other.sessionId } } } } })));
        });
        expect(denied).not.toContain(other.marker);
      } finally { socket.terminate(); }
      const upload = await fetch(`${baseUrl}/api/agent/native/${scope}/api/session/uploadFileBinary?sessionId=${own.sessionId}&name=private.txt`, { method: "POST", headers: { "X-API-Key": own.key, "Content-Type": "application/octet-stream" }, body: Buffer.from(own.marker) });
      expect(upload.status).toBe(200); const receipt = await upload.json(); expect(receipt.ok).toBe(true);
      const foreignFile = await rpc(other.key, "prompt", { request: { sessionId: other.sessionId, requestId: "foreign-file-" + own.sessionId, mode: "queue", content: [{ type: "file", receiptId: receipt.value.receiptId }] } });
      expect(JSON.stringify(foreignFile)).toContain("FILE_NOT_STAGED");
      expect(JSON.stringify(foreignFile)).not.toContain(own.marker);
      const chunk = (name: string, data: Buffer) => {
        const payload = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
        for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
        const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([length, payload, checksum]);
      };
      const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
      const image = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0,10,20,30,255]))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
      const accepted = await rpc(own.key, "prompt", { request: { sessionId: own.sessionId, requestId: "image-" + own.sessionId, mode: "queue", content: [{ type: "text", text: "Private image read test" }, { type: "image", mediaType: "image/png", data: image }] } });
      expect(accepted.result.value?.accepted, JSON.stringify(accepted)).toBe(true);
      let attachmentId: string | undefined;
      const imageId = (value: any): string | undefined => {
        if (!value || typeof value !== "object") return;
        if (value.type === "image" && typeof value.attachment?.attachmentId === "string") return value.attachment.attachmentId;
        for (const child of Object.values(value)) { const found = imageId(child); if (found) return found; }
      };
      const imageSocket = new WebSocket(baseUrl.replace("http:", "ws:") + `/api/agent/native/${scope}/api/remote.mux`, { headers: { "X-API-Key": own.key } });
      let imageThroughSeq = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Image event was not received")), 5000);
          imageSocket.once("error", error => { clearTimeout(timer); reject(error); });
          imageSocket.on("message", frame => {
            const text = frame.toString();
            for (const match of text.matchAll(/"seq":(\d+)/g)) imageThroughSeq = Math.max(imageThroughSeq, Number(match[1]));
            if (text.includes("Private image read test")) { clearTimeout(timer); resolve(); }
          });
          imageSocket.once("open", () => imageSocket.send(JSON.stringify({ type: "open", streamId: "image", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: own.sessionId } } } } })));
        });
      } finally { imageSocket.terminate(); }
      attachmentId = imageId(await rpc(own.key, "page", { request: { address: { kind: "session", sessionId: own.sessionId }, throughSeq: imageThroughSeq } }));
      expect(attachmentId).toBeTruthy();
      const read = await rpc(own.key, "attachment", { request: { sessionId: own.sessionId, attachmentId } });
      expect(read.result.ok, JSON.stringify(read)).toBe(true);
      expect(read.result.value.data).toBe(image);
      const foreignImage = await rpc(other.key, "attachment", { request: { sessionId: own.sessionId, attachmentId } });
      expect(foreignImage.result.ok).toBe(false);
      expect(JSON.stringify(foreignImage)).not.toContain(image);


      expect(JSON.stringify(await rpc(own.key, "page", { request: { address: { kind: "session", sessionId: own.sessionId }, throughSeq: 0 } }))).toContain(own.marker);
    }
  }, 20000);

  it("isolates native sessions across applications and user/developer identities", async () => {
    const owner = findUserByName("harness-http-admin")!;
    const provider = "matrix";
    expect((await app.inject({ method: "PUT", url: "/api/agent/settings", headers: { "X-API-Key": adminKey }, payload: { providers: [{ id: provider, name: "Matrix", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, model: "matrix-model", apiKey: "matrix-key" }], defaultProviderId: provider, grants: {}, mcpServers: [] } })).statusCode).toBe(200);
    const names = ["matrix-first-app", "matrix-second-app"];
    for (const name of names) {
      const directory = path.join(dataDir, owner.id, name); await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ name, userId: owner.id, currentVersion: 1, versions: [], metadata: {}, pageAccess: { level: "owner" } }));
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ name, agent: { capabilities: [] } }));
    }
    const projectResponse = await fetch(baseUrl + "/api/development/projects", { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ name: names[0] }) });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()).data;
    const prefixes = names.map(name => "/api/agent/native/" + Buffer.from(JSON.stringify({ appId: "harness-http-admin/" + name, providerId: provider })).toString("base64url") + "/api/session/");
    prefixes.push(`/api/development/projects/${project.id}/native/${provider}/api/session/`);
    const rpc = async (prefix: string, method: string, args: unknown) => {
      const response = await fetch(baseUrl + prefix + method, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "matrix-" + method, method: "session/" + method, payload: { args } }) });
      expect(response.status).toBe(200); return response.json();
    };
    const rows = [];
    for (const [index, prefix] of prefixes.entries()) {
      const sessionId = (await rpc(prefix, "create", { request: {} })).result.value.sessionId;
      const marker = "application-identity-private-marker-" + index;
      await rpc(prefix, "rename", { request: { sessionId, title: marker } });
      expect((await rpc(prefix, "prompt", { request: { sessionId, requestId: marker, mode: "queue", content: [{ type: "text", text: marker }] } })).result.value.accepted).toBe(true);
      await expect.poll(async () => JSON.stringify(await rpc(prefix, "search", { request: { query: marker } })), { timeout: 5000 }).toContain(marker);
      const upload = await fetch(baseUrl + prefix + `uploadFileBinary?sessionId=${sessionId}&name=private.txt`, { method: "POST", headers: { "X-API-Key": adminKey, "Content-Type": "application/octet-stream" }, body: Buffer.from(marker) });
      expect(upload.status).toBe(200);
      const receipt = await upload.json(); expect(receipt.ok).toBe(true);
      rows.push({ prefix, sessionId, marker, receiptId: receipt.value.receiptId });
    }
    const followScope = async (prefix: string, sessionId: string, marker: string, allowed: boolean) => {
      const socket = new WebSocket(baseUrl.replace("http:", "ws:") + prefix.replace(/session\/$/, "remote.mux"), { headers: { "X-API-Key": adminKey } });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Scoped subscription did not resolve")), 5000);
          const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
          socket.once("error", error => finish(error));
          socket.on("message", frame => {
            const text = frame.toString(); const value = JSON.parse(text);
            if (text.includes(marker)) finish(allowed ? undefined : new Error("Foreign scoped trajectory leaked"));
            else if (["end", "error"].includes(value.type)) finish(allowed ? new Error("Own trajectory was unavailable") : undefined);
          });
          socket.once("open", () => socket.send(JSON.stringify({ type: "open", streamId: "matrix", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } })));
        });
      } finally { socket.terminate(); }
    };
    for (const own of rows) {
      await followScope(own.prefix, own.sessionId, own.marker, true);
      const ownFile = await rpc(own.prefix, "prompt", { request: { sessionId: own.sessionId, requestId: "own-file-" + own.sessionId, mode: "queue", content: [{ type: "file", receiptId: own.receiptId }] } });
      expect(ownFile.result.value?.accepted, JSON.stringify(ownFile)).toBe(true);
      expect(JSON.stringify(await rpc(own.prefix, "list", { _request: {} }))).toContain(own.sessionId);
      expect(JSON.stringify(await rpc(own.prefix, "page", { request: { address: { kind: "session", sessionId: own.sessionId }, throughSeq: 0 } }))).toContain(own.marker);
      for (const foreign of rows.filter(row => row !== own)) {
        expect(JSON.stringify(await rpc(own.prefix, "list", { _request: {} }))).not.toContain(foreign.sessionId);
        expect(JSON.stringify(await rpc(own.prefix, "search", { request: { query: foreign.marker } }))).not.toContain(foreign.sessionId);
        expect(JSON.stringify(await rpc(own.prefix, "page", { request: { address: { kind: "session", sessionId: foreign.sessionId }, throughSeq: 0 } }))).not.toContain(foreign.marker);
        const staged = await rpc(own.prefix, "prompt", { request: { sessionId: own.sessionId, requestId: "foreign-file-" + foreign.sessionId, mode: "queue", content: [{ type: "file", receiptId: foreign.receiptId }] } });
        expect(JSON.stringify(staged)).toContain("FILE_NOT_STAGED");
        expect(JSON.stringify(staged)).not.toContain(foreign.marker);
        await followScope(own.prefix, foreign.sessionId, foreign.marker, false);
      }
    }
  }, 20000);

});
