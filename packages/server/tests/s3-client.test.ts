import path from "node:path";
import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

import { initS3Client, putObject, getObject } from "../src/lib/s3-client.js";
import { S3Client } from "@aws-sdk/client-s3";
// The plugin is compiled as CommonJS; spy on the shared SDK prototype so both
// ESM tests and the real plugin module observe the same send implementation.
const __mockSend = vi.spyOn(S3Client.prototype, "send");

const testConfig = {
  port: 3000,
  dataDir: path.resolve(import.meta.dirname, "../../../tmp/s3-client-unit"),
  jwtSecret: "secret",
  bootstrapApiKey: "key",
  templateRepoUrl: "http://example.com",
  gitDownloadUrl: "",
  adminStaticDir: "",
  minCliVersion: "",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  llmBaseUrl: "https://api.openai.com/v1",
  minioEndpoint: "localhost:9000",
  minioAccessKey: "minioadmin",
  minioSecretKey: "minioadmin",
  minioBucket: "test-bucket",
};

describe("s3-client", () => {
  afterAll(() => __mockSend.mockRestore());
  afterEach(async () => { await fs.rm(testConfig.dataDir, {recursive: true, force: true}); });
  beforeEach(() => {
    __mockSend.mockReset();
  });

  describe("initS3Client", () => {
    it("creates S3 client and ensures bucket exists", async () => {
      __mockSend.mockResolvedValueOnce({});
      await initS3Client(testConfig);
      expect(__mockSend).toHaveBeenCalledTimes(1);
    });

    it("creates bucket when it does not exist", async () => {
      const notFound = new Error("NotFound");
      (notFound as { name: string }).name = "NotFound";
      __mockSend.mockRejectedValueOnce(notFound).mockResolvedValueOnce({});
      await initS3Client(testConfig);
      expect(__mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("putObject", () => {
    it("sends PutObjectCommand with correct params", async () => {
      __mockSend.mockResolvedValueOnce({});
      await initS3Client(testConfig);
      __mockSend.mockResolvedValueOnce({});

      await putObject("user/app/file.png", Buffer.from("data"), "image/png");

      const lastCall = __mockSend.mock.calls[1][0];
      expect(lastCall.input.Bucket).toBe("test-bucket");
      expect(lastCall.input.Key).toBe("user/app/file.png");
      expect(lastCall.input.ContentType).toBe("image/png");
    });
  });

  describe("getObject", () => {
    it("returns body and contentType when object exists", async () => {
      __mockSend.mockResolvedValueOnce({});
      await initS3Client(testConfig);

      const bodyBytes = new Uint8Array([1, 2, 3]);
      __mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(bodyBytes) },
        ContentType: "image/png",
      });

      const result = await getObject("user/app/file.png");
      expect(result).toEqual({
        body: Buffer.from(bodyBytes),
        contentType: "image/png",
      });
    });

    it("returns null when object does not exist", async () => {
      __mockSend.mockResolvedValueOnce({});
      await initS3Client(testConfig);

      const err = new Error("no such key");
      (err as { name: string }).name = "NoSuchKey";
      __mockSend.mockRejectedValueOnce(err);

      const result = await getObject("nonexistent");
      expect(result).toBeNull();
    });
  });
});
