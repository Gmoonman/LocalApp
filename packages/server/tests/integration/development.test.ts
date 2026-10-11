import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createTestPage, createTestServer } from "./helpers.js";
import { registerAndLogin } from "../helpers/createUser.js";
let server: Awaited<ReturnType<typeof createTestServer>>,
  alice: string,
  bob: string;
beforeAll(async () => {
  server = await createTestServer({
    dataRoot: path.resolve(
      __dirname,
      "../../../../tmp/platform-development/integration",
    ),
  });
  alice = await registerAndLogin(server.baseUrl, "developer");
  bob = await registerAndLogin(server.baseUrl, "reader");
}, 30000);
afterAll(async () => {
  await server?.stop();
});
const call = (cookie: string, url: string, method = "GET", body?: unknown) =>
  fetch(server.baseUrl + "/api/development/projects" + url, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
it("isolates developer capability settings by user and project", async () => {
  const create = async (cookie: string, name: string) => {
    const result = await call(cookie, "", "POST", { name });
    expect(result.status).toBe(201);
    return (await result.json()).data.id;
  };
  const first = await create(alice, "settings-first"), second = await create(alice, "settings-second"), foreign = await create(bob, "settings-foreign");
  const endpoint = `/${first}/agent/settings`;
  const input = { enabledCapabilities: ["files"], disabledTools: ["write"] };
  expect((await call("", endpoint)).status).toBe(401);
  expect((await call(bob, endpoint)).status).toBe(404);
  expect((await call(bob, endpoint, "PUT", input)).status).toBe(404);
  expect((await call(alice, `/${foreign}/agent/settings`, "PUT", input)).status).toBe(404);
  expect((await call(alice, endpoint, "PUT", { ...input, enabledCapabilities: ["unknown-capability"] })).status).toBe(400);
  expect((await call(alice, endpoint, "PUT", { ...input, disabledTools: [123] })).status).toBe(400);
  expect((await call(alice, endpoint, "PUT", input)).status).toBe(200);
  expect((await (await call(alice, endpoint)).json()).data).toMatchObject(input);
  const other = (await (await call(alice, `/${second}/agent/settings`)).json()).data;
  expect(other.enabledCapabilities).toContain("terminal");
  expect(other.disabledTools).toEqual([]);
  const foreignSettings = (await (await call(bob, `/${foreign}/agent/settings`)).json()).data;
  expect(foreignSettings.enabledCapabilities).toContain("terminal");
  expect(foreignSettings.disabledTools).toEqual([]);
});
it("creates a builtin source project and rejects cross-user access and stale saves", async () => {
  expect((await call("", "/")).status).toBe(401);
  const create = await call(alice, "", "POST", { name: "browser-app" });
  expect(create.status).toBe(201);
  const p = (await create.json()).data;
  const files = (await (await call(alice, `/${p.id}/files`)).json()).data;
  expect(files).toContain("manifest.json");
  expect(files.some((f: string) => f.startsWith("src/"))).toBe(true);
  const f = (
    await (await call(alice, `/${p.id}/file?path=manifest.json`)).json()
  ).data;
  expect(JSON.parse(f.content).name).toBe("browser-app");
  expect((await call(bob, `/${p.id}/files`)).status).toBe(404);
  const changed = JSON.stringify({
    ...JSON.parse(f.content),
    description: "edited",
  });
  expect(
    (
      await call(alice, `/${p.id}/file`, "PUT", {
        path: f.path,
        hash: f.hash,
        content: changed,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(alice, `/${p.id}/file`, "PUT", {
        path: f.path,
        hash: f.hash,
        content: "stale",
      })
    ).status,
  ).toBe(409);
  expect((await call(alice, `/${p.id}/file?path=../secret`)).status).toBe(400);
  const versions = (await (await call(alice, `/${p.id}/versions`)).json()).data;
  const diff = (
    await (await call(alice, `/${p.id}/diff?version=${versions[0].id}`)).json()
  ).data;
  expect(diff.some((d: any) => d.path === "manifest.json")).toBe(true);
  expect(
    (await call(alice, `/${p.id}/restore`, "POST", { version: versions[0].id }))
      .status,
  ).toBe(200);
  expect(
    (await call(alice, `/${p.id}/agent/run`, "POST", { prompt: "Read" }))
      .status,
  ).toBe(400);
}, 30000);

it("only owners can attach original app source, without replacing installed assets", async () => {
  await createTestPage(server.app, "developer", "existing-app");
  const endpoint =
    server.baseUrl + "/api/development/apps/developer/existing-app/source";
  const req = (cookie: string, method = "GET", body?: unknown) =>
    fetch(endpoint, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await req("")).status).toBe(401);
  expect((await req(bob)).status).toBe(403);
  expect((await (await req(alice)).json()).data).toBe(null);
  expect((await req(bob, "POST", { files: {} })).status).toBe(403);
  expect(
    (
      await req(alice, "POST", {
        files: { "manifest.json": '{"name":"wrong"}', "package.json": "{}" },
      })
    ).status,
  ).toBe(400);
  const { templateSource } = await import(
    "../../src/lib/development/template.js"
  );
  const files = templateSource("existing-app");
  files["src/App.tsx"] = "export const App = () => 'Original application';";
  const imported = await req(alice, "POST", { files });
  expect(imported.status).toBe(200);
  const p = (await imported.json()).data;
  expect((await (await req(alice)).json()).data.id).toBe(p.id);
  expect((await req(alice, "POST", { files })).status).toBe(409);
  const source = await call(alice, `/${p.id}/file?path=src/App.tsx`);
  expect((await source.json()).data.content).toContain("Original application");
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(server.dataDir, "developer/existing-app/meta.json"),
        "utf8",
      ),
    ).currentVersion,
  ).toBe(1);
}, 30000);

it("keeps uploaded binary references out of source and rejects other users and foreign attachment IDs", async () => {
  const p = (
    await (await call(alice, "", "POST", { name: "attachment-app" })).json()
  ).data;
  const form = () => {
    const body = new FormData();
    body.append(
      "file",
      new Blob([new Uint8Array([37, 80, 68, 70, 0, 255])], {
        type: "application/pdf",
      }),
      "reference.pdf",
    );
    return body;
  };
  const url = server.baseUrl + `/api/development/projects/${p.id}/attachments`;
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: { Cookie: bob },
        body: form(),
      })
    ).status,
  ).toBe(404);
  const res = await fetch(url, {
    method: "POST",
    headers: { Cookie: alice },
    body: form(),
  });
  expect(res.status).toBe(200);
  const attachment = (await res.json()).data;
  expect(attachment.name).toBe("reference.pdf");
  const bytes = fs.readFileSync(
    path.join(
      server.dataDir,
      "development/projects",
      p.id,
      "workspace",
      attachment.path,
    ),
  );
  expect([...bytes]).toEqual([37, 80, 68, 70, 0, 255]);
  const source = (await (await call(alice, `/${p.id}/files`)).json()).data;
  expect(
    source.some((file: string) => file.includes(".localapp-attachments")),
  ).toBe(false);
  const foreign = await call(alice, `/${p.id}/agent/run`, "POST", {
    prompt: "Read attached file",
    attachmentIds: ["00000000-0000-0000-0000-000000000000"],
  });
  expect(foreign.status).toBe(404);
});

it("migrates original source with the distributed skill helper, preserving binary assets and the installed app", async () => {
  await createTestPage(server.app, "developer", "migration-app");
  const root = path.resolve(__dirname, "../../../../tmp/platform-development/migration-skill");
  fs.rmSync(root, {recursive:true,force:true});
  fs.mkdirSync(path.join(root,"source","public"), { recursive: true });
  fs.mkdirSync(path.join(root,"profiles"), { recursive: true });
  const project = path.join(root,"source");
  fs.writeFileSync(path.join(project,"manifest.json"), JSON.stringify({name:"migration-app"}));
  fs.writeFileSync(path.join(project,"package.json"), JSON.stringify({scripts:{test:"test",build:"build"}}));
  const binary = Buffer.from([137,80,78,71,0,255]);
  fs.writeFileSync(path.join(project,"public","logo.png"), binary);
  fs.writeFileSync(path.join(project,".env"),"TEST_SECRET=excluded");
  const { createApiKey } = await import("../../src/lib/meta-sqlite.js");
  const key = createApiKey("developer").key;
  fs.writeFileSync(path.join(root,"profiles","profiles.json"), JSON.stringify({version:1,profiles:{test:{serverUrl:server.baseUrl,apiKey:key}}}));
  const oldConfig = process.env.LOCALAPP_CONFIG_DIR;
  process.env.LOCALAPP_CONFIG_DIR = path.join(root,"profiles");
  const deployed = path.join(server.dataDir,"developer","migration-app","meta.json");
  const installedBefore = JSON.parse(fs.readFileSync(deployed,"utf8"));
  const asset = path.join(server.dataDir,"developer","migration-app","versions","v1","index.html");
  fs.mkdirSync(path.dirname(asset),{recursive:true});
  fs.writeFileSync(asset,"Installed application marker");
  try {
    const { migrate } = await import("../../../../init-repo/.claude/skills/localapp-migrate/scripts/migrate-source.mjs");
    const inspected = await migrate({project});
    expect(inspected.status).toBe("checked");
    expect(inspected.omitted).toContain(".env");
    const result = await migrate({project,profile:"test",upload:true,cliVersion:"99.0.0"});
    expect(result.status).toBe("hosted");
    expect(result.fileCount).toBe(3);
    expect(fs.readFileSync(path.join(server.dataDir,"development","projects",result.projectId,"workspace","public","logo.png"))).toEqual(binary);
    const installedAfter = JSON.parse(fs.readFileSync(deployed,"utf8"));
    expect(installedAfter.currentVersion).toBe(installedBefore.currentVersion);
    expect(installedAfter.versions).toHaveLength(installedBefore.versions.length);
    expect(fs.readFileSync(asset,"utf8")).toBe("Installed application marker");
    expect(fs.readFileSync(path.join(project,".localapp","source-migration.json"),"utf8")).not.toContain(key);
    expect((await migrate({project,profile:"test",upload:true,cliVersion:"99.0.0"})).status).toBe("already-hosted");
    expect(result.owner).toBe("developer");
    const {syncSource} = await import("../../../localapp/src/commands/app-source.js");
    const checkout = path.join(root, "checkout");
    const store = {resolve: async () => ({name: "test", serverUrl: server.baseUrl, apiKey: key})};
    expect((await syncSource({action: "pull", profile: "test", name: "migration-app", directory: checkout, store})).status).toBe("pulled");
    expect(fs.readFileSync(path.join(checkout, "public/logo.png"))).toEqual(binary);
    await expect(syncSource({action: "pull", profile: "test", name: "migration-app", directory: checkout, store})).rejects.toThrow();
    fs.mkdirSync(path.join(checkout, "tmp/localapp-dev"), {recursive: true});
    fs.writeFileSync(path.join(checkout, "tmp/localapp-dev/secret"), "local credentials");
    fs.writeFileSync(path.join(checkout, "new.txt"), "local edit");
    fs.unlinkSync(path.join(checkout, "public/logo.png"));
    expect((await syncSource({action: "push", profile: "test", directory: checkout, store})).status).toBe("pushed");
    const workspace = path.join(server.dataDir, "development/projects", result.projectId, "workspace");
    expect(fs.readFileSync(path.join(workspace, "new.txt"), "utf8")).toBe("local edit");
    expect(fs.existsSync(path.join(workspace, "public/logo.png"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "tmp"))).toBe(false);
    fs.writeFileSync(path.join(workspace, "new.txt"), "unsaved remote edit");
    await expect(syncSource({action: "push", profile: "test", directory: checkout, store})).rejects.toThrow(/改变|合并/);
    expect(fs.readFileSync(path.join(workspace, "new.txt"), "utf8")).toBe("unsaved remote edit");
    const readerKey = createApiKey("reader").key;
    await expect(syncSource({action: "push", profile: "test", directory: checkout, store: {resolve: async () => ({name: "reader", serverUrl: server.baseUrl, apiKey: readerKey})}})).rejects.toThrow(/API Key/);
    expect(fs.readFileSync(asset, "utf8")).toBe("Installed application marker");
    expect(fs.readFileSync(path.join(checkout, ".localapp/source.json"), "utf8")).not.toContain(key);
    fs.symlinkSync(path.join(project,"manifest.json"), path.join(project,"linked.json"));
    await expect(migrate({project})).rejects.toThrow("符号链接");
  } finally { if (oldConfig === undefined) delete process.env.LOCALAPP_CONFIG_DIR; else process.env.LOCALAPP_CONFIG_DIR = oldConfig; fs.rmSync(root,{recursive:true,force:true}); }
});

it("serves native dsh development sessions only to the project owner",async()=>{
 const settings=await fetch(server.baseUrl+"/api/agent/settings",{method:"PUT",headers:{Cookie:alice,"Content-Type":"application/json"},body:JSON.stringify({providers:[{id:"native-dev",name:"Native development",protocol:"openai-completions",baseUrl:"http://127.0.0.1:9/v1",model:"test-model",apiKey:"test-key"}],defaultProviderId:"native-dev",grants:{},mcpServers:[]})});
 expect(settings.status).toBe(200);
 const p=(await (await call(alice,"","POST",{name:"native-development"})).json()).data;
 const body={type:"client-request",rpcId:"dev-list",method:"session/list",payload:{args:{_request:{}}}};
 const response=await call(alice,`/${p.id}/native/api/session/list`,"POST",body);
 expect(response.status).toBe(200);
 const value=await response.json();expect(JSON.stringify(value)).not.toContain("test-key");
 expect(value.type).toBe("server-response");
 const createNative=(request:unknown)=>call(alice,`/${p.id}/native/api/session/create`,"POST",{type:"client-request",rpcId:"dev-create",method:"session/create",payload:{args:{request}}});
 const created=await createNative({});expect(created.status).toBe(200);
 expect((await created.json()).result.value.sessionId).toMatch(/^session-/);
 expect(await (await createNative({cwd:server.dataDir})).text()).toContain("outside the application workspace");
 expect(await (await createNative({sessionId:"../escape"})).text()).toContain("Invalid session ID");
 expect((await call(bob,`/${p.id}/native/api/session/list`,"POST",body)).status).toBe(404);
 expect((await call("",`/${p.id}/native/api/session/list`,"POST",body)).status).toBe(401);
},30000);
