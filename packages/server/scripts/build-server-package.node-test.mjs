import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildServerPackage } from "./build-server-package.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const testRoot = path.join(projectDirectory, "tmp/server-package-e2e");

test("packed Node Server initializes and serves Web without repository dependencies", async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });
  const outputDirectory = path.join(testRoot, "artifact");
  const repeatedDirectory = path.join(testRoot, "artifact-repeat");
  const dataDirectory = await fs.mkdtemp(path.join(testRoot, "data-"));
  const artifact = await buildServerPackage({ outputDirectory });
  const repeated = await buildServerPackage({ outputDirectory: repeatedDirectory });
  assert.equal(artifact.bundleDigest, repeated.bundleDigest);
  const manifest = JSON.parse(await fs.readFile(artifact.manifestPath, "utf8"));
  assert.ok(manifest.files["runner/task-supervisor.mjs"]);
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(outputDirectory, "runner/task-supervisor.mjs")]), error => error.code === 125 && /Invalid LocalApp task supervisor invocation/.test(error.stderr));
  const serverBundle = await fs.readFile(path.join(outputDirectory, "bin/server-cli.cjs"), "utf8");
  assert.match(serverBundle, /@localapp\/dsh-app-platform\/app-db/);
  assert.ok(manifest.files["node_modules/@localapp/dsh-document-tools/dist/catalog.cjs"]);
  assert.ok(manifest.files["node_modules/@localapp/dsh-document-tools/skills/pdf/SKILL.md"]);
  assert.ok(manifest.files["node_modules/@localapp/dsh-multiuser/dist/user-workspace-root.cjs"]);
  assert.ok(manifest.files["native-client/entry.js"]);
  assert.ok(manifest.files["native-client/entry.css"]);
  assert.ok(manifest.files["node_modules/@localapp/dsh-app-platform/dist/index.mjs"]);
  assert.ok(manifest.files["node_modules/@localapp/dsh-app-platform/dist/access-control.cjs"]);
  for (const entry of ["app-db", "migrations", "runtime-errors", "issue-task-conversion", "notify-permission-sql", "models"]) {
    assert.ok(manifest.files[`node_modules/@localapp/dsh-app-platform/dist/${entry}.cjs`]);
  }
  for (const entry of ["app-runtime", "backend-actions", "backend-contract", "app-api-contract", "transitions", "record-access", "content-capabilities", "platform-capabilities"]) {
    assert.ok(manifest.files[`node_modules/@localapp/dsh-app-platform/dist/${entry}.cjs`]);
  }
  for (const entry of ["issue-templates", "issue-saved-views", "issue-saved-replies"]) {
    assert.ok(manifest.files[`node_modules/@localapp/dsh-app-platform/dist/${entry}.cjs`]);
  }
  for (const entry of ["page-storage", "app-manifest", "notify-config", "file-utils"]) {
    assert.ok(manifest.files[`node_modules/@localapp/dsh-app-platform/dist/${entry}.cjs`]);
  }
  assert.ok(Object.keys(manifest.files).some(file => file.startsWith("native-client/assets/") && file.endsWith(".woff2")));
  for (const skill of ["markitdown", "pdf", "docx", "xlsx"]) {
    assert.ok(manifest.files[`skills/${skill}/SKILL.md`]);
    assert.ok(manifest.files[`skills/${skill}/LICENSE`]);
    assert.ok(manifest.files[`skills/${skill}/SOURCE.json`]);
    assert.ok(Object.keys(manifest.files).some((file) => file.startsWith(`skills/${skill}/scripts/`) && file.endsWith(".py")));
  }
  for (const plugin of ["dsh-client-modules", "dsh-client-ui-chat", "dsh-client-ui-trajectory", "dsh-client-ui-renderer"]) {
    assert.ok(manifest.files["node_modules/@deepseek-ai/" + plugin + "/lib/client.js"], plugin + " client artifact must be packaged");
  }
  assert.ok(manifest.files["node_modules/@localapp/dsh-multiuser/dist/native-client.mjs"]);
  assert.ok(manifest.files["node_modules/@localapp/dsh-app-development/ui/creation-dialog.tsx"]);
  const clientBoot = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { Context } from "@deepseek-ai/cordis";
    import fs from "node:fs";
    import DocumentTools from "@localapp/dsh-document-tools";
    import ApplicationPlatform from "@localapp/dsh-app-platform";
    import ApplicationDevelopment from "@localapp/dsh-app-development";
    import { initializeAccountSchema } from "@localapp/dsh-multiuser/account-schema";
    import { mountNativeClientModules } from "@localapp/dsh-multiuser/native-client";
    for (const name of ["@localapp/dsh-document-tools", "@localapp/dsh-agent-ui", "@localapp/dsh-multiuser", "@localapp/dsh-app-platform", "@localapp/dsh-app-development"]) {
      const metadata = JSON.parse(fs.readFileSync(process.cwd() + "/node_modules/" + name + "/package.json", "utf8"));
      for (const subpath of Object.keys(metadata.exports)) {
        // The browser entry requires the original dsh module loader and is
        // exercised by the real native-client browser tests instead.
        // The supervisor is an executable entry, checked above in a subprocess.
        if (subpath === "./task-supervisor" || subpath === "./client" || subpath.startsWith("./ui/")) continue;
        const specifier = name + (subpath === "." ? "" : subpath.slice(1));
        const loaded = await import(specifier);
        if (!Object.keys(loaded).length) throw new Error("Empty packaged plugin entry: " + specifier);
      }
    }
    const ctx = new Context();
    try {
      await ctx.plugin(DocumentTools);
      const docReport = { checks: ["runner", "python", "docx"].map(id => ({ id, status: "ready" })) };
      const prepared = ctx.localappDocuments.prepare(process.cwd() + "/document-probe", ["docx"], docReport);
      if (!fs.existsSync(prepared + "/docx/SKILL.md") || !fs.existsSync(prepared + "/docx/LICENSE")) throw new Error("Packaged document plugin resources missing");
      await ctx.plugin(ApplicationPlatform, { owner: () => undefined, application: () => undefined, canAccess: () => false });
      const database = ctx.localappApps.database;
      const dbPath = process.cwd() + "/plugin-probe.sqlite";
      await database.getConnection(dbPath);
      database.execRawSql(dbPath, "CREATE TABLE probe (value TEXT)");
      database.execRawSql(dbPath, "INSERT INTO probe VALUES (?)", ["persisted"]);
      database.closeAllConnections();
      await database.getConnection(dbPath);
      const stored = database.execRawSql(dbPath, "SELECT value FROM probe");
      if (stored.rows?.[0]?.value !== "persisted") throw new Error("Packaged plugin database did not persist");
      const runtime = ctx.localappApps.appRuntime.createAppNamedSqlRuntime({
        dbPath,
        context: () => ({ visitorId: "owner", ownerId: "owner", now: new Date() }),
        contract: { files: [], resources: {}, mutations: {}, queries: {
          "probe.read": { kind: "query", sql: "SELECT value FROM probe", access: "owner", params: {}, result: { mode: "bounded", maxRows: 1, maxBytes: 1024 } }
        } }
      });
      const query = await runtime.execute({ kind: "named-query", name: "probe.read" }, { params: {} });
      if (query.rows?.[0]?.value !== "persisted") throw new Error("Packaged plugin Named SQL failed");
      await ctx.localappApps.issues.savedViews.createIssueSavedView(dbPath, "owner", { name: "Open work", query: { status: "open" } });
      database.closeAllConnections();
      const ownerViews = await ctx.localappApps.issues.savedViews.listIssueSavedViews(dbPath, "owner");
      const otherViews = await ctx.localappApps.issues.savedViews.listIssueSavedViews(dbPath, "other");
      if (ownerViews[0]?.name !== "Open work" || otherViews.length !== 0) throw new Error("Packaged Issue views failed persistence or user isolation");
      const pages = ctx.localappApps.pages;
      const dataRoot = process.cwd() + "/page-probe";
      const developmentDbPath = process.cwd() + "/development-meta.db";
      const developmentDb = await database.getConnection(developmentDbPath);
      await ctx.plugin(ApplicationDevelopment, { dataDir: dataRoot, persistence: { database: () => developmentDb, flush: () => fs.writeFileSync(developmentDbPath, developmentDb.export()) } });
      ctx.localappApps.initializeSchema(developmentDb, initializeAccountSchema);
      const workspaces = ctx.localappDevelopment.workspaces({ workspaceDir: dataRoot + "/workspaces", authorizeExecution: () => true });
      const workspace = await workspaces.create({ name: "packaged-task", ownerId: "owner" });
      const taskRunner = ctx.localappDevelopment.taskRunner({ workspaceStore: workspaces, taskDir: dataRoot + "/tasks", supervisorPath: process.cwd() + "/runner/task-supervisor.mjs", authorizeExecution: user => user === "owner" });
      const task = await taskRunner.start({ workspaceId: workspace.id, kind: "test", executable: "node", args: ["-e", "console.log('packaged task completed')"], timeoutMs: 5000, requestedBy: "owner" });
      const deadline = Date.now() + 10000;
      while (ctx.localappDevelopment.tasks.get(task.id)?.status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (ctx.localappDevelopment.tasks.get(task.id)?.status !== "succeeded") throw new Error("Packaged task did not succeed");
      if (!taskRunner.logs(task.id, 0).content.includes("packaged task completed")) throw new Error("Packaged task log missing");
      const activeTask = await taskRunner.start({ workspaceId: workspace.id, kind: "test", executable: "node", args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 10000, requestedBy: "owner" });
      await taskRunner.shutdown();
      if (ctx.localappDevelopment.tasks.get(activeTask.id)?.status !== "interrupted") throw new Error("Packaged task shutdown did not interrupt running work");
      const projects = ctx.localappDevelopment.projects;
      const project = projects.create("owner", "package-development", { "main.txt": "source persisted", "asset.bin": { encoding: "base64", content: "AAH/" } });
      if (projects.list("owner")[0]?.id !== project.id || projects.list("other").length) throw new Error("Packaged development project isolation failed");
      if (!fs.existsSync(projects.workspace(project.id, "owner") + "/asset.bin")) throw new Error("Packaged development binary source missing");
      const pageDir = pages.getPageDir(dataRoot, "owner", "probe");
      fs.mkdirSync(pageDir + "/versions/v1", { recursive: true });
      fs.writeFileSync(pageDir + "/versions/v1/index.html", "legacy app");
      const now = new Date().toISOString();
      pages.writePageMeta(dataRoot, "owner", "probe", { name: "probe", userId: "owner", description: "", currentVersion: 1, createdAt: now, updatedAt: now, metadata: {}, versions: [{ version: 1, createdAt: now, fileCount: 1, totalSize: 10 }] });
      const meta = pages.readPageMeta(dataRoot, "owner", "probe");
      if (meta.currentAppVersion !== "legacy-1" || !/^[a-f0-9]{64}$/.test(meta.versions[0].digest)) throw new Error("Packaged legacy page metadata did not migrate");
      const storage = ctx.localappApps.content.storage;
      await storage.initContentStorage({ dataDir: dataRoot, minioEndpoint: "127.0.0.1:1", minioAccessKey: "test", minioSecretKey: "test", minioBucket: "test" });
      const binary = Buffer.from([0, 1, 127, 128, 255]);
      await storage.putObject("owner/probe/file.bin", binary, "application/octet-stream");
      const restored = await storage.getObject("owner/probe/file.bin");
      if (!restored?.body.equals(binary)) throw new Error("Packaged content storage lost binary bytes");
      database.closeAllConnections();
      const modules = await mountNativeClientModules(ctx);
      const graph = modules.graph();
      for (const entry of graph.entries) {
        if (!modules.clientPath(entry.id)?.startsWith(process.cwd())) throw new Error("Client artifact escaped package: " + entry.id);
        const response = await modules.fetchBundle(new Request("http://package.test/" + entry.url));
        if (response.status !== 200) throw new Error("Client artifact missing: " + entry.id);
      }
      console.log(JSON.stringify({ entries: graph.entries.length }));
    } finally { await ctx.fiber.dispose(); }
  `], { cwd: outputDirectory, env: { ...process.env, NODE_PATH: "" }, timeout: 30000 });
  assert.ok(JSON.parse(clientBoot.stdout.trim().split("\n").at(-1)).entries >= 23);
  assert.match(await fs.readFile(artifact.bin, "utf8"), /LOCALAPP_PUBLIC_SKILLS_ROOT/);
  assert.equal((await fs.readFile(artifact.bin, "utf8")).startsWith("#!/usr/bin/env node\n"), true);

  const packageKey = randomUUID();
  const modelKey = randomUUID();
  const modelRequests = [];
  const modelServer = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    modelRequests.push({ ...JSON.parse(raw), authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({choices:[{delta:{content:"isolated-package-agent-reply"},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => modelServer.listen(0,"127.0.0.1",resolve));
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  const child = spawn(process.execPath, [artifact.bin, "start", "--data-dir", dataDirectory, "--port", "0"], {
    cwd: outputDirectory,
    env: { ...process.env, NODE_PATH: "", BOOTSTRAP_API_KEY: packageKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const ready = await readReadyLine(child).catch(error => { throw new Error(error.message + "\n" + stderr); });
    assert.equal(ready.type, "ready");
    assert.equal((await fetch(`${ready.url}/health`)).status, 200);
    const setupResponse = await fetch(ready.setupUrl);
    assert.equal(setupResponse.status, 200, stderr);
    assert.match(await setupResponse.text(), /Create|admin|管理员/i);
    assert.equal(await fileExists(path.join(dataDirectory, "jwt.key")), true);
    const headers = { "X-API-Key": packageKey, "Content-Type": "application/json" };
    const setup = await fetch(ready.url + "/api/setup/initialize", { method: "POST", headers,
      body: JSON.stringify({ token: new URL(ready.setupUrl).searchParams.get("token"), username: "native-package-owner", password: randomUUID() }) });
    assert.equal(setup.status, 201);
    const settings = await fetch(ready.url + "/api/agent/settings", { method: "PUT", headers,
      body: JSON.stringify({ providers: [{ id: "model", name: "Package model", protocol: "openai-completions", baseUrl: modelUrl, model: "package-model", apiKey: modelKey }], defaultProviderId: "model", grants: {}, mcpServers: [] }) });
    assert.equal(settings.status, 200);
    const scope = Buffer.from(JSON.stringify({ appId: "platform", providerId: "model" })).toString("base64url");
    const pageUrl = ready.url + "/api/agent/native/" + scope + "/";
    const nativePage = await fetch(pageUrl, { headers });
    const nativeHtml = await nativePage.text();
    assert.equal(nativePage.status, 200, nativeHtml + stderr);
    assert.match(nativeHtml, /__DSH_BOOT__/);
    const nativeScript = await fetch(pageUrl + "client/entry.js", { headers });
    assert.equal(nativeScript.status, 200);
    assert.match(await nativeScript.text(), /Native client mount point is missing/);
    const nativeCreate=await fetch(pageUrl+"api/session/create",{method:"POST",headers,
      body:JSON.stringify({type:"client-request",rpcId:"package-native-create",method:"session/create",payload:{args:{request:{}}}})});
    assert.equal(nativeCreate.status,200,stderr);
    const nativeSession=(await nativeCreate.json()).result.value.sessionId;
    assert.equal(typeof nativeSession,"string");
    const nativeSubmission=JSON.stringify({type:"client-request",rpcId:"package-native-prompt",method:"session/prompt",payload:{args:{request:{sessionId:nativeSession,requestId:"package-native-request",mode:"queue",content:[{type:"text",text:"verify isolated native admission"}]}}}});
    const nativePrompt=await fetch(pageUrl+"api/session/prompt",{method:"POST",headers,body:nativeSubmission});
    assert.equal(nativePrompt.status,200,stderr);
    assert.equal((await nativePrompt.json()).result.value.accepted,true);
    const run = await fetch(ready.url + "/api/agent/run", {method:"POST",headers,signal:AbortSignal.timeout(15000),
      body:JSON.stringify({sessionId:"package-agent",providerId:"model",prompt:"verify isolated package execution",systemPrompt:"",tools:[]})});
    assert.equal(run.status,200,stderr);
    assert.match(await run.text(),/isolated-package-agent-reply/);
    assert.ok(modelRequests.some(request => request.authorization === `Bearer ${modelKey}` && request.model === "package-model" && JSON.stringify(request.messages).includes("verify isolated package execution")));
    child.kill("SIGTERM");await onceExit(child);
    const nativeRequestCount=()=>modelRequests.filter(request=>JSON.stringify(request.messages).includes("verify isolated native admission")).length;
    const requestsBeforeRestart=nativeRequestCount();assert.ok(requestsBeforeRestart>0);
    const restarted=spawn(process.execPath,[artifact.bin,"start","--data-dir",dataDirectory,"--port","0"],{cwd:outputDirectory,env:{...process.env,NODE_PATH:"",BOOTSTRAP_API_KEY:packageKey},stdio:["ignore","pipe","pipe"]});
    let restartErrors="";restarted.stderr.setEncoding("utf8");restarted.stderr.on("data",chunk=>{restartErrors+=chunk;});
    try{
      const restartReady=await readReadyLine(restarted);
      const restartedApi=restartReady.url+"/api/agent/native/"+scope+"/api/session/";
      const listed=await fetch(restartedApi+"list",{method:"POST",headers,body:JSON.stringify({type:"client-request",rpcId:"package-restored-list",method:"session/list",payload:{args:{_request:{}}}})});
      assert.equal(listed.status,200,restartErrors);
      const restoredList=await listed.json();assert.equal(restoredList.result.ok,true,JSON.stringify(restoredList));
      assert.ok(restoredList.result.value.items.some(item=>item.sessionId===nativeSession));
      const repeated=await fetch(restartedApi+"prompt",{method:"POST",headers,body:nativeSubmission});
      assert.equal(repeated.status,200,restartErrors);assert.equal((await repeated.json()).result.value.accepted,true);
    }finally{restarted.kill("SIGTERM");await onceExit(restarted);}
    assert.equal(nativeRequestCount(),requestsBeforeRestart);
    for (const combination of ["multiuser", "platform"]) {
      const reducedData = path.join(testRoot, combination);
      await fs.mkdir(reducedData, { recursive: true });
      await fs.writeFile(path.join(reducedData, "plugins.json"), JSON.stringify({ combination, documentsEnabled: false }));
      const reduced = spawn(process.execPath, [artifact.bin, "start", "--data-dir", reducedData, "--port", "0"], {
        cwd: outputDirectory,
        env: { ...process.env, NODE_PATH: "", BOOTSTRAP_API_KEY: packageKey, LOCALAPP_PLUGIN_COMBINATION: combination },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostic = "";
      reduced.stderr.on("data", chunk => { diagnostic += chunk.toString(); });
      try {
        const ready = await readReadyLine(reduced);
        const report = await (await fetch(ready.url + "/api/system/plugins")).json();
        assert.equal(report.data.combination, combination, diagnostic);
        assert.equal(report.data.development, false);
        assert.equal(report.data.applications, combination === "platform");
        assert.equal((await fetch(ready.url + "/api/development/creations")).status, 404);
        const initialize = await fetch(ready.url + "/api/setup/initialize", { method: "POST", headers, body: JSON.stringify({ token: new URL(ready.setupUrl).searchParams.get("token"), username: "reduced-package-owner", password: randomUUID() }) });
        assert.equal(initialize.status, 201, await initialize.text());
        const pluginSettings = await fetch(ready.url + "/api/system/settings/plugins", { headers });
        assert.equal(pluginSettings.status, 200);
        assert.equal((await pluginSettings.json()).data.documentsEnabled, false);
        if (combination === "multiuser") {
          const preferences = await fetch(ready.url + "/api/agent/app-settings?appId=platform", { headers });
          assert.equal(preferences.status, 200);
          const skills = (await preferences.json()).data.skills;
          assert.equal(skills.length, 4);
          assert.ok(skills.every(skill => !skill.available && skill.unavailableReason === "公共文档扩展尚未启用。"));
        }
      } finally {
        if (!reduced.killed) reduced.kill("SIGTERM");
        await onceExit(reduced);
      }
    }

  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await onceExit(child);
    await new Promise(resolve => modelServer.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

async function readReadyLine(child) {
  const stream = child.stdout;
  let buffer = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = (code, signal) => onError(new Error(`Server exited before readiness: ${code ?? signal}`));
    const onData = chunk => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "ready") { cleanup(); resolve(message); return; }
      }
    };
    const timer = setTimeout(() => onError(new Error("Server readiness timed out after 30 seconds")), 30_000);
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.on("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function fileExists(filePath) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() ?? false;
}
