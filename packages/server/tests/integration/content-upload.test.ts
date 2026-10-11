import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestServer, getAppUrl, createTestPage } from "./helpers.js";
import { registerAndLogin } from "../helpers/createUser.js";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/lib/s3-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/s3-client.js")>(),
  initS3Client: vi.fn().mockResolvedValue(undefined),
  initContentStorage: vi.fn().mockResolvedValue(undefined),
  putObject: vi.fn().mockResolvedValue(undefined),
  putObjectFromFile: vi.fn().mockResolvedValue(undefined),
  getObject: vi.fn().mockResolvedValue(null),
  openObject: vi.fn().mockResolvedValue(null),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  deleteAppObjects: vi.fn().mockResolvedValue(undefined),
  listAppObjects: vi.fn().mockResolvedValue([]),
}));

import { putObject, getObject } from "../../src/lib/s3-client.js";

const mockPutObject = vi.mocked(putObject);
const mockGetObject = vi.mocked(getObject);

describe("Content upload API", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let stop: () => Promise<void>;
  let cookies: string;

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    stop = server.stop;

    // Register and login
    cookies = await registerAndLogin(baseUrl, "contentuser", "pass123456");

    // Create a test page
    const userId = "contentuser";
    createTestPage(app, userId, "test-app");
  });

  afterAll(async () => {
    await stop();
  });

  it("uploads a PNG file successfully", async () => {
    mockPutObject.mockResolvedValueOnce(undefined);

    const formData = new FormData();
    formData.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "photo.png");

    const res = await fetch(`${baseUrl}/serve/contentuser/test-app/api/content/upload`, {
      method: "POST",
      headers: { cookie: cookies.split(";")[0] },
      body: formData,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.key).toMatch(/\.png$/);
    expect(body.data.url).toContain("/serve/contentuser/test-app/api/content/");
    expect(mockPutObject).toHaveBeenCalled();
  });

  it("uploads a valid PDF with the canonical content type", async () => {
    const formData = new FormData();
    formData.append("file", new Blob([Buffer.from("%PDF-1.7\n%%EOF")], { type: "application/pdf" }), "invoice.pdf");

    const res = await fetch(`${baseUrl}/serve/contentuser/test-app/api/content/upload`, {
      method: "POST",
      headers: { cookie: cookies.split(";")[0] },
      body: formData,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, data: { key: expect.stringMatching(/\.pdf$/) } });
    expect(mockPutObject).toHaveBeenLastCalledWith(expect.stringMatching(/\.pdf$/), expect.any(Buffer), "application/pdf");
  });

  it.each([
    ["photo.png", "application/pdf", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "CONTENT_MIME_MISMATCH", 400],
    ["photo.png", "image/png", Buffer.from("not a png"), "CONTENT_SIGNATURE_INVALID", 400],
    ["photo.png", "image/png", Buffer.alloc(10 * 1024 * 1024 + 1), "CONTENT_TOO_LARGE", 413],
  ])("rejects invalid content %# with a stable code", async (filename, mimeType, bytes, code, status) => {
    const formData = new FormData();
    formData.append("file", new Blob([bytes], { type: mimeType }), filename);

    const res = await fetch(`${baseUrl}/serve/contentuser/test-app/api/content/upload`, {
      method: "POST",
      headers: { cookie: cookies.split(";")[0] },
      body: formData,
    });

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ success: false, code });
  });

  it("returns 400 when no file provided", async () => {
    // Send a multipart form without any file field
    const formData = new FormData();
    formData.append("other", "value");

    const res = await fetch(`${baseUrl}/serve/contentuser/test-app/api/content/upload`, {
      method: "POST",
      headers: { cookie: cookies.split(";")[0] },
      body: formData,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No file provided");
  });

  it("returns 400 for unsupported file type", async () => {
    const formData = new FormData();
    formData.append("file", new Blob(["text"], { type: "text/plain" }), "doc.txt");

    const res = await fetch(`${baseUrl}/serve/contentuser/test-app/api/content/upload`, {
      method: "POST",
      headers: { cookie: cookies.split(";")[0] },
      body: formData,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Unsupported file type");
  });

  it("returns 401 when not logged in on authenticated page", async () => {
    createTestPage(app, "contentuser", "auth-app", { pageAccess: { level: "authenticated" } });
    const formData = new FormData();
    formData.append("file", new Blob([Buffer.from("data")], { type: "image/png" }), "photo.png");

    const res = await fetch(`${baseUrl}/serve/contentuser/auth-app/api/content/upload`, {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(401);
  });
});

describe("Content read API", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let stop: () => Promise<void>;
  let cookies: string;

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    stop = server.stop;

    cookies = await registerAndLogin(baseUrl, "readuser", "pass123456");

    createTestPage(app, "readuser", "read-app");
  });

  afterAll(async () => {
    await stop();
  });

  it("reads an uploaded file", async () => {
    const imgBuffer = Buffer.from("fake-image-data");
    mockGetObject.mockResolvedValueOnce({
      body: imgBuffer,
      contentType: "image/png",
    });

    const res = await fetch(`${baseUrl}/serve/readuser/read-app/api/content/abc123.png`, {
      headers: { cookie: cookies.split(";")[0] },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const data = await res.arrayBuffer();
    expect(Buffer.from(data)).toEqual(imgBuffer);
  });

  it("serves a PDF with safe full and range responses", async () => {
    const pdf = Buffer.from("%PDF-1.7\n0123456789\n%%EOF");
    mockGetObject.mockResolvedValueOnce({ body: pdf, contentType: "application/pdf" });

    const full = await fetch(`${baseUrl}/serve/readuser/read-app/api/content/invoice.pdf`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("application/pdf");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("content-disposition")).toContain("inline");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(pdf);

    mockGetObject.mockResolvedValueOnce({ body: pdf, contentType: "application/pdf" });
    const partial = await fetch(`${baseUrl}/serve/readuser/read-app/api/content/invoice.pdf`, {
      headers: { Range: "bytes=5-9" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 5-9/${pdf.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(pdf.subarray(5, 10));
  });

  it("returns 404 for non-existent file", async () => {
    mockGetObject.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/serve/readuser/read-app/api/content/nonexistent.png`, {
      headers: { cookie: cookies.split(";")[0] },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("File not found");
  });

  it("serves content for public page without auth", async () => {
    const imgBuffer = Buffer.from("public-image");
    mockGetObject.mockResolvedValueOnce({
      body: imgBuffer,
      contentType: "image/jpeg",
    });

    // createTestPage creates pages with default public access
    const res = await fetch(`${baseUrl}/serve/readuser/read-app/api/content/pub.jpg`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("returns 401 for authenticated page without session", async () => {
    createTestPage(app, "readuser", "protected-app", { pageAccess: { level: "authenticated" } });
    mockGetObject.mockResolvedValueOnce({ body: Buffer.from("data"), contentType: "image/png" });

    const res = await fetch(`${baseUrl}/serve/readuser/protected-app/api/content/test.png`);

    expect(res.status).toBe(401);
  });

  it("returns 403 for owner page when not owner", async () => {
    createTestPage(app, "readuser", "owner-app", { pageAccess: { level: "owner" } });
    mockGetObject.mockResolvedValueOnce({ body: Buffer.from("data"), contentType: "image/png" });

    // Register another user
    const otherCookies = await registerAndLogin(baseUrl, "otheruser", "pass123456");

    const res = await fetch(`${baseUrl}/serve/readuser/owner-app/api/content/test.png`, {
      headers: { cookie: otherCookies.split(";")[0] },
    });

    expect(res.status).toBe(403);
  });
});
