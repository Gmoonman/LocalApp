import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { registerApplicationEntry } from "@localapp/dsh-app-platform/application-entry-routes";
it("bundles production attachments with newly generated Excel in the test write environment", async () => {
  const parent = path.resolve("../../tmp/content-bundle-preview");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const page = path.join(root, "preview", "demo");
  fs.mkdirSync(page, { recursive: true });
  fs.writeFileSync(
    path.join(page, "meta.json"),
    JSON.stringify({
      name: "demo",
      userId: "owner",
      currentVersion: 1,
      versions: [],
      metadata: {},
    }),
  );
  const pdf = "a".repeat(20) + ".pdf",
    excel = "b".repeat(20) + ".xlsx";
  const objects = new Map([
    ["owner/demo/" + pdf, Buffer.from("production attachment")],
    ["preview/demo/" + excel, Buffer.from("test Excel")],
  ]);
  const opened: string[] = [];
  const app = Fastify();
  try {
    await registerApplicationEntry(app, {
      webRoot: root,
      dataDir: () => root,
      previewData: () => ({
        databasePath: path.join(root, "owner", "demo", "app.db"),
        ownerId: "owner",
        readSource: "production",
        writeSource: "test",
      }),
      visitorId: (req) =>
        typeof req.headers["x-test-user"] === "string"
          ? req.headers["x-test-user"]
          : null,
      visitorName: () => null,
      userId: () => undefined,
      now: () => undefined,
      keyOwner: () => null,
      user: () => null,
      userCount: () => 1,
      pushPageView: () => undefined,
      notifications: {
        resolveRecipients: async () => [],
        persistNotifications: () => undefined,
      } as any,
      sessions: undefined as any,
      desktopAction: async () => {
        throw new Error("unused");
      },
      deviceAction: async () => {
        throw new Error("unused");
      },
      storage: {
        putObject: async () => undefined,
        getObject: async () => null,
        openObject: async (key) => {
          if (objects.has(key)) opened.push(key);
          return objects.has(key)
            ? { body: Readable.from([objects.get(key)!]) }
            : null;
        },
      },
    });
    const base = "/serve/preview/demo/api/content/bundles";
    const payload = {
      files: [
        { key: excel, path: "export.xlsx" },
        { key: pdf, path: "附件/source.pdf" },
      ],
      idempotencyKey: "mixed",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers: { "x-test-user": "other" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: base,
      headers: { "x-test-user": "owner" },
      payload,
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().data.id;
    let data: any;
    for (let i = 0; i < 200; i++) {
      data = (
        await app.inject({
          url: base + "/" + id,
          headers: { "x-test-user": "owner" },
        })
      ).json().data;
      if (data.state === "completed" || data.state === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(data).toMatchObject({
      state: "completed",
      processedFiles: 2,
      downloadUrl: base + "/" + id + "/download",
    });
    expect(opened).toEqual(["preview/demo/" + excel, "owner/demo/" + pdf]);
    expect(
      (
        await app.inject({
          url: data.downloadUrl,
          headers: { "x-test-user": "owner" },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
