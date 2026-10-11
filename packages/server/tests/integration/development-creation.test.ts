import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createTestServer } from "./helpers.js";
import { registerAndLogin } from "../helpers/createUser.js";
import { ProjectStore } from "../../src/lib/development/projects.js";
import { ApplicationCreations } from "../../src/lib/development/creation.js";
import { readPageMeta } from "../../src/plugins/storage.js";
let server: Awaited<ReturnType<typeof createTestServer>>,
  owner: string,
  other: string;
beforeAll(async () => {
  server = await createTestServer({
    dataRoot: path.resolve(
      __dirname,
      "../../../../tmp/platform-development/creation-integration",
    ),
  });
  owner = await registerAndLogin(server.baseUrl, "creator");
  other = await registerAndLogin(server.baseUrl, "other");
}, 30000);
afterAll(async () => server?.stop());
it("keeps drafts private, requires the proposed name, installs a starter and retains the project and session", async () => {
  const store = new ProjectStore(server.dataDir),
    creations = new ApplicationCreations(server.dataDir, store);
  const draft = creations.create("creator", "configured-model");
  const call = (cookie: string, suffix: string, body?: unknown) =>
    fetch(
      server.baseUrl + `/api/development/creations/${draft.projectId}${suffix}`,
      {
        method: body ? "POST" : "GET",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
  const list = async (cookie: string) => (await (await fetch(server.baseUrl + "/api/development/creations", { headers: { Cookie: cookie } })).json()).data;
  expect(await list(owner)).toEqual([expect.objectContaining({ projectId: draft.projectId, sessionId: draft.sessionId })]);
  expect(await list(other)).toEqual([]);
  expect(store.list("creator")).toEqual([]);
  expect(readPageMeta(server.dataDir, "creator", "created-app")).toBeNull();
  expect((await call(other, "")).status).toBe(404);
  expect((await call(owner, "/confirm", { name: "created-app" })).status).toBe(
    400,
  );
  creations.propose(draft.projectId, "creator", {
    name: "created-app",
    description: "一个用于追踪工作项的应用",
  });
  expect((await call(owner, "/confirm", { name: "another-name" })).status).toBe(
    400,
  );
  const response = await call(owner, "/confirm", { name: "created-app" });
  expect(response.status, await response.clone().text()).toBe(200);
  const ready = (await response.json()).data;
  expect(await list(owner)).toEqual([]);
  expect(ready.projectId).toBe(draft.projectId);
  expect(ready.sessionId).toBe(draft.sessionId);
  expect(ready.url).toBe(`/creator/created-app/?creation=${draft.projectId}`);
  expect(store.list("creator").map((p) => p.name)).toEqual(["created-app"]);
  expect(
    JSON.parse(store.read(draft.projectId, "creator", "manifest.json").content)
      .name,
  ).toBe("created-app");
  expect(
    readPageMeta(server.dataDir, "creator", "created-app")?.versions,
  ).toHaveLength(1);
  expect(
    (await fetch(server.baseUrl + ready.url, { headers: { Cookie: owner } }))
      .status,
  ).toBe(200);
  expect((await call(owner, "/confirm", { name: "created-app" })).status).toBe(
    200,
  );
  expect(
    readPageMeta(server.dataDir, "creator", "created-app")?.versions,
  ).toHaveLength(1);
  expect(() =>
    creations.continue(draft.projectId, "creator", "wrong-session"),
  ).toThrow();
  expect(
    creations.continue(draft.projectId, "creator", draft.sessionId),
  ).toContain("一个用于追踪工作项的应用");
  expect(() =>
    creations.continue(draft.projectId, "creator", draft.sessionId),
  ).toThrow();
}, 30000);
