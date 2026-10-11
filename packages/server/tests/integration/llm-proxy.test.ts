import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { AgentSettingsStore } from "../../src/lib/agent-settings.js";
import { storagePlugin } from "../../src/plugins/storage.js";
import { authPlugin } from "../../src/plugins/auth.js";
import { sessionPlugin } from "../../src/plugins/session.js";
import { authRoutes } from "../../src/routes/auth.js";
import { createLlmRoutesHost } from "../../src/routes/llm.js";
import { closeMetaDb } from "../../src/lib/meta-sqlite.js";
import { registerAndLogin } from "../helpers/createUser.js";

function getAppUrl(app: FastifyInstance): string {
  const addr = app.addresses()[0];
  if (!addr || typeof addr === "string") throw new Error("Server not listening");
  return `http://127.0.0.1:${addr.port}`;
}

async function createLlmTestServer(envOverrides?: Record<string, string | undefined>) {
  const testRoot = path.resolve(__dirname, "../../../../tmp/llm-proxy-tests");
  await fs.promises.mkdir(testRoot, { recursive: true });
  const dataDir = await fs.promises.mkdtemp(path.join(testRoot, "run-"));
  const env: Record<string, string | undefined> = {
    DATA_DIR: dataDir,
    BOOTSTRAP_API_KEY: "test-api-key-1234567890abcdef",
    TEMPLATE_REPO_URL: "https://github.com/example/template.git",
    GIT_DOWNLOAD_URL: "https://example.com/git-install.exe",
    JWT_SECRET: "test-jwt-secret-key",
    ADMIN_STATIC_DIR: path.resolve(__dirname, "../../static/admin"),
    LLM_API_KEY: "test-llm-key",
    LLM_MODEL: "gpt-4o-mini",
    LLM_BASE_URL: "http://localhost:1",
    ...envOverrides,
  };

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const app = Fastify({ ignoreTrailingSlash: true });
  await app.register(storagePlugin);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(sessionPlugin);
  app.register(authRoutes);
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: Multiuser } = await import("@localapp/dsh-multiuser");
  const context = new Context();
  await context.plugin(Multiuser);
  app.addHook("onClose", () => context.fiber.dispose());
  app.register(async scope => {
    await authPlugin(scope);
    await context.localappMultiuser.registerLlm(scope, createLlmRoutesHost(app, context.localappMultiuser));
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    baseUrl: getAppUrl(app),
    stop: async () => {
      closeMetaDb();
      await app.close();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    },
  };
}

function createMockLlm(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("LLM 代理端点", () => {
  describe("鉴权和请求验证", () => {
    let baseUrl: string;
    let stop: () => Promise<void>;
    let authCookie: string;

    beforeAll(async () => {
      const server = await createLlmTestServer();
      baseUrl = server.baseUrl;
      stop = server.stop;
      authCookie = await registerAndLogin(baseUrl, "alice");
      new AgentSettingsStore(process.env.DATA_DIR!).write("alice", { providers: [{ id: "own", name: "Own model", protocol: "openai-completions", baseUrl: process.env.LLM_BASE_URL!, apiKey: "user-model-key", model: "gpt-4o-mini" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    });

    afterAll(async () => {
      await stop();
    });

    it("未登录用户发起对话返回 401", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      expect(res.status).toBe(401);
    });

    it("请求体缺少 messages 返回 400", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("messages 格式错误返回 400", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: "invalid" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("用户未配置模型供应商", () => {
    let baseUrl: string;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      const server = await createLlmTestServer({ LLM_API_KEY: undefined });
      baseUrl = server.baseUrl;
      stop = server.stop;
    });

    afterAll(async () => {
      await stop();
    });

    it("返回 400 提示用户配置模型", async () => {
      const authCookie = await registerAndLogin(baseUrl, "alice");
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("成功流程", () => {
    let baseUrl: string;
    let stop: () => Promise<void>;
    let authCookie: string;
    let mockLlm: { url: string; close: () => Promise<void> };
    let capturedRequests: Record<string, unknown>[];

    beforeAll(async () => {
      capturedRequests = [];
      mockLlm = await createMockLlm((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", () => {
          try {
            capturedRequests.push(JSON.parse(body));
          } catch {}
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"你"},"index":0}]}\n\n',
          );
          res.write(
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"好"},"index":0}]}\n\n',
          );
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });

      const server = await createLlmTestServer({ LLM_BASE_URL: mockLlm.url });
      baseUrl = server.baseUrl;
      stop = server.stop;
      authCookie = await registerAndLogin(baseUrl, "alice");
      new AgentSettingsStore(process.env.DATA_DIR!).write("alice", { providers: [{ id: "own", name: "Own model", protocol: "openai-completions", baseUrl: process.env.LLM_BASE_URL!, apiKey: "user-model-key", model: "gpt-4o-mini" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    });

    afterAll(async () => {
      await mockLlm.close();
      await stop();
    });

    it("已登录用户发起对话返回 SSE 流", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("流式响应包含 LLM chunk 和 [DONE]", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      const text = await res.text();
      expect(text).toContain("data:");
      expect(text).toContain("[DONE]");
    });

    it("默认模型为 gpt-4o-mini", async () => {
      capturedRequests.length = 0;
      await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(capturedRequests.length).toBeGreaterThan(0);
      expect(capturedRequests[capturedRequests.length - 1].model).toBe("gpt-4o-mini");
    });
  });

  describe("LLM 服务不可用", () => {
    let baseUrl: string;
    let stop: () => Promise<void>;
    let authCookie: string;

    beforeAll(async () => {
      const server = await createLlmTestServer({ LLM_BASE_URL: "http://localhost:1" });
      baseUrl = server.baseUrl;
      stop = server.stop;
      authCookie = await registerAndLogin(baseUrl, "alice");
      new AgentSettingsStore(process.env.DATA_DIR!).write("alice", { providers: [{ id: "own", name: "Own model", protocol: "openai-completions", baseUrl: process.env.LLM_BASE_URL!, apiKey: "user-model-key", model: "gpt-4o-mini" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    });

    afterAll(async () => {
      await stop();
    });

    it("返回 502 并包含上游错误信息", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("流式响应中断", () => {
    let baseUrl: string;
    let stop: () => Promise<void>;
    let authCookie: string;
    let mockLlm: { url: string; close: () => Promise<void> };

    beforeAll(async () => {
      mockLlm = await createMockLlm((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"你"},"index":0}]}\n\n');
        // Simulate interruption: destroy the connection mid-stream
        setTimeout(() => res.destroy(new Error("Connection reset")), 50);
      });

      const server = await createLlmTestServer({ LLM_BASE_URL: mockLlm.url });
      baseUrl = server.baseUrl;
      stop = server.stop;
      authCookie = await registerAndLogin(baseUrl, "alice");
      new AgentSettingsStore(process.env.DATA_DIR!).write("alice", { providers: [{ id: "own", name: "Own model", protocol: "openai-completions", baseUrl: process.env.LLM_BASE_URL!, apiKey: "user-model-key", model: "gpt-4o-mini" }], defaultProviderId: "own", grants: {}, mcpServers: [] });
    });

    afterAll(async () => {
      await mockLlm.close();
      await stop();
    });

    it("流式响应中断后仍返回部分数据或错误信息", async () => {
      const res = await fetch(`${baseUrl}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
      });
      const text = await res.text();
      // Should have received at least the first chunk before interruption
      expect(text).toContain("data:");
    });
  });
});
