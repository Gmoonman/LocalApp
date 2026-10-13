import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import path from "node:path";
import { createTestServer, createTestPage } from "./helpers.js";
import { registerAndLogin } from "../helpers/createUser.js";
import yauzl from "yauzl";
function zipEntries(buffer: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const names: string[] = [];
      zip.on("entry", (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names));
      zip.on("error", reject);
      zip.readEntry();
    }),
  );
}
async function workbook(): Promise<Buffer> {
  const { ZipArchive } = await import("archiver");
  const zip = new ZipArchive();
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk) => chunks.push(chunk));
  zip.pipe(out);
  const done = finished(out);
  zip.append(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    { name: "[Content_Types].xml" },
  );
  zip.append(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
    { name: "xl/workbook.xml" },
  );
  await zip.finalize();
  await done;
  return Buffer.concat(chunks);
}
describe("authenticated file bundle HTTP API", () => {
  it("uploads XLSX, bundles 300 PDFs, polls progress, downloads once and blocks other users", async () => {
    const root = path.resolve("../../tmp/content-bundle-http");
    const server = await createTestServer({
      dataRoot: root,
      env: { MINIO_ENDPOINT: "127.0.0.1:19999" },
    });
    try {
      const owner = await registerAndLogin(
        server.baseUrl,
        "bundleowner",
        "pass123456",
      );
      const other = await registerAndLogin(
        server.baseUrl,
        "bundleother",
        "pass123456",
      );
      await createTestPage(server.app, "bundleowner", "export");
      const base = `${server.baseUrl}/serve/bundleowner/export/api/content`;
      const upload = async (
        bytes: Buffer,
        name: string,
        type: string,
        cookie = owner,
      ) => {
        const form = new FormData();
        form.append("file", new Blob([bytes], { type }), name);
        const res = await fetch(base + "/upload", {
          method: "POST",
          headers: { cookie },
          body: form,
        });
        expect(res.status).toBe(201);
        return (await res.json()).data.key as string;
      };
      const excel = await upload(
        await workbook(),
        "导出.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      const files = [{ key: excel, path: "汇总/导出.xlsx" }];
      for (let i = 0; i < 300; i++) {
        const key = await upload(
          Buffer.from("%PDF-1.7\n%%EOF"),
          "invoice.pdf",
          "application/pdf",
        );
        files.push({ key, path: `附件/凭证-${i}.pdf` });
      }
      const create = async (cookie: string, entries = files) =>
        fetch(base + "/bundles", {
          method: "POST",
          headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            files: entries,
            idempotencyKey: "batch-export",
          }),
        });
      expect((await create("")).status).toBe(401);
      expect((await create(other)).status).toBe(403);
      const res = await create(owner);
      expect(res.status).toBe(202);
      const job = (await res.json()).data;
      expect((await (await create(owner)).json()).data.id).toBe(job.id);
      const states: string[] = [];
      for (let i = 0; i < 500; i++) {
        const poll = await fetch(base + "/bundles/" + job.id, {
          headers: { cookie: owner },
        });
        const status = (await poll.json()).data;
        states.push(status.state);
        if (status.state === "failed") throw Error(status.error);
        if (status.state === "completed") {
          expect(status.processedFiles).toBe(301);
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(states).toContain("completed");
      const url = base + "/bundles/" + job.id + "/download";
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { cookie: other } })).status).toBe(
        404,
      );
      const download = await fetch(url, { headers: { cookie: owner } });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/zip");
      expect(
        await zipEntries(Buffer.from(await download.arrayBuffer())),
      ).toEqual(files.map((f) => f.path));
      const ownKey = await upload(
        Buffer.from("%PDF-1.7\n%%EOF"),
        "own.pdf",
        "application/pdf",
        other,
      );
      expect(
        (
          await fetch(base + "/bundles", {
            method: "POST",
            headers: { cookie: other, "Content-Type": "application/json" },
            body: JSON.stringify({
              files: [{ key: ownKey, path: "own.pdf" }],
              idempotencyKey: "own",
            }),
          })
        ).status,
      ).toBe(202);
    } finally {
      await server.stop();
    }
  }, 60000);
});
