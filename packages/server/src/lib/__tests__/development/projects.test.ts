import { beforeEach, afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../../development/projects.js";
import { initMetaDb, closeMetaDb } from "../../meta-sqlite.js";
const base = path.resolve(__dirname, "../../../../../../tmp/platform-development/project-tests");
let store: ProjectStore;
beforeEach(async () => { closeMetaDb(); fs.rmSync(base, {recursive:true,force:true}); fs.mkdirSync(base,{recursive:true}); await initMetaDb(base); store=new ProjectStore(base); });
afterEach(() => { closeMetaDb(); fs.rmSync(base,{recursive:true,force:true}); });
it("owns projects independently of application access and models", () => {
 const p=store.create("alice","example-app",{"manifest.json":'{"name":"example-app"}',"src/main.ts":"first"});
 expect(store.list("alice")).toHaveLength(1); expect(store.list("bob")).toEqual([]);
 expect(()=>store.get(p.id,"bob")).toThrow(); expect(store.get(p.id,"alice").name).toBe("example-app");
});
it("rejects stale saves, unsafe paths and writes during an Agent turn", () => {
 const p=store.create("alice","example-app",{"src/main.ts":"first"});
 const f=store.read(p.id,"alice","src/main.ts");
 store.write(p.id,"alice","src/main.ts","second",f.hash);
 expect(()=>store.write(p.id,"alice","src/main.ts","stale",f.hash)).toThrow(/改变|冲突/);
 expect(()=>store.read(p.id,"alice","../secret")).toThrow();
 fs.symlinkSync(base,path.join(store.workspace(p.id,"alice"),"outside"));
 expect(()=>store.write(p.id,"alice","outside/x","x",null)).toThrow();
 const release=store.lock(p.id,"alice"); expect(()=>store.write(p.id,"alice","src/main.ts","x",null)).toThrow(/占用/); release();
});
it("retains fixed snapshots and restores as a new version", () => {
 const p=store.create("alice","example-app",{"src/main.ts":"first"});
 const initial=store.versions(p.id,"alice")[0];
 const f=store.read(p.id,"alice","src/main.ts"); store.write(p.id,"alice","src/main.ts","second",f.hash);
 const next=store.snapshot(p.id,"alice","change");
 expect(store.versionFiles(p.id,"alice",initial.id)["src/main.ts"]).toBe("first");
 expect(store.versionFiles(p.id,"alice",next.id)["src/main.ts"]).toBe("second");
 store.restore(p.id,"alice",initial.id); expect(store.read(p.id,"alice","src/main.ts").content).toBe("first");
 expect(store.versions(p.id,"alice")).toHaveLength(3);
});
it("blocks internal, secret and binary files", () => {
 const p=store.create("alice","example-app",{"src/main.ts":"first"});
 for(const file of [".env",".git/config","node_modules/x",".localapp/dev-config.json"]){expect(()=>store.write(p.id,"alice",file,"secret",null)).toThrow();}
 expect(()=>store.write(p.id,"alice","src/a","\0",null)).toThrow();
});

it("preserves binary source through snapshots and restore without text corruption", () => {
 const bytes = Buffer.from([0, 255, 137, 80, 78, 71]);
 const original = { encoding: "base64" as const, content: bytes.toString("base64") };
 const p = store.create("alice", "binary-source", { "public/logo.png": original, "src/main.ts": "first" });
 const version = store.versions(p.id, "alice")[0];
 expect(fs.readFileSync(path.join(store.workspace(p.id,"alice"),"public/logo.png"))).toEqual(bytes);
 expect(store.versionFiles(p.id,"alice",version.id)["public/logo.png"]).toEqual(original);
 expect(() => store.read(p.id,"alice","public/logo.png")).toThrow("二进制");
 fs.writeFileSync(path.join(store.workspace(p.id,"alice"),"public/logo.png"),Buffer.from([1,2,3]));
 store.restore(p.id,"alice",version.id);
 expect(fs.readFileSync(path.join(store.workspace(p.id,"alice"),"public/logo.png"))).toEqual(bytes);
 expect(() => store.create("alice","invalid-binary",{"logo.png":{encoding:"base64",content:"invalid!"}})).toThrow("编码");
});
it("source sync respects locks and leaves the workspace unchanged on invalid uploads", () => {
 const files = {"manifest.json": '{"name":"sync-app"}', "package.json": '{"scripts":{"test":"test","build":"build"}}', "old.txt": "original"};
 const p = store.create("alice", "sync-app", files);
 const digest = store.versions(p.id, "alice")[0].digest;
 const unlock = store.lock(p.id, "alice");
 expect(() => store.replaceSource(p.id, "alice", files, digest)).toThrow(/占用/); unlock();
 expect(() => store.replaceSource(p.id, "bob", files, digest)).toThrow();
 expect(() => store.replaceSource(p.id, "alice", {...files, "../outside": "unsafe"}, digest)).toThrow();
 expect(() => store.replaceSource(p.id, "alice", {...files, "binary": {encoding: "base64", content: "invalid!"}}, digest)).toThrow();
 expect(store.read(p.id, "alice", "old.txt").content).toBe("original");
 expect(store.versions(p.id, "alice")).toHaveLength(1);
});

it("exports source with an isolated digest and releases its lock",()=>{
 const files={"manifest.json":'{"name":"export-app"}',"package.json":'{"scripts":{"test":"test","build":"build"}}',"public/image.bin":{encoding:"base64" as const,content:Buffer.from([0,255,128]).toString("base64")}};
 const p=store.create("alice","export-app",files);
 expect(()=>store.exportSource(p.id,"bob")).toThrow();
 const exported=store.exportSource(p.id,"alice");
 expect(exported.files["public/image.bin"]).toEqual(files["public/image.bin"]);
 expect(exported.digest).toBe(store.versions(p.id,"alice")[0].digest);
 store.replaceSource(p.id,"alice",{...files,"new.txt":"new"},exported.digest);
 expect(()=>store.replaceSource(p.id,"alice",files,exported.digest)).toThrow();
 expect(store.exportSource(p.id,"alice").files["new.txt"]).toBe("new");
});
