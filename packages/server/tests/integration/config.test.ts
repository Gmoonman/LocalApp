import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTestServer, getAppUrl, getTestApiKey } from "./helpers.js";
import type { FastifyInstance } from "fastify";
import path from "node:path";

it("keeps CLI minimum-version checks on migrated business routes", async () => {
  const server = await createTestServer({ dataRoot: path.resolve(__dirname, "../../../../tmp/version-check"), env: { MIN_CLI_VERSION: "0.4.0" } });
  try {
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "localadmin", password: "localadmin" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find(value => value.name === "token")!;
    expect(cookie).toBeDefined();
    for (const url of ["/api/config", "/api/keys", "/api/pages", "/api/workspaces"]) {
      const headers = { "x-api-key": getTestApiKey() };
      expect((await server.app.inject({ url, headers })).statusCode, url).toBe(403);
      expect((await server.app.inject({ url, headers: { ...headers, "x-cli-version": "0.3.0" } })).statusCode, url).toBe(403);
      expect((await server.app.inject({ url, headers: { ...headers, "x-cli-version": "0.4.0" } })).statusCode, url).toBe(200);
      expect((await server.app.inject({ url, cookies: { token: cookie.value } })).statusCode, url).toBe(200);
      expect((await server.app.inject({ url, cookies: { token: cookie.value }, headers: { "x-api-key": "invalid", "x-cli-version": "0.4.0" } })).statusCode, url).toBe(401);
    }
  } finally { await server.stop(); }
});

describe("server-config — env vars", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let stop: () => Promise<void>;
  const apiKey = getTestApiKey();

  beforeAll(async () => {
    const server = await createTestServer();
    app = server.app;
    baseUrl = getAppUrl(app);
    stop = server.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it("should return config with valid API key", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { "X-API-Key": apiKey },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.templateRepoUrl).toBe("https://github.com/example/template.git");
    expect(data.gitDownloadUrl).toBe("https://example.com/git-install.exe");
  });

  it("should return 401 without API key", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(401);
  });

  it("should return 401 with invalid API key", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { "X-API-Key": "invalid-key" },
    });
    expect(res.status).toBe(401);
  });

  it("should return null gitDownloadUrl when not configured", async () => {
    const server = await createTestServer({ env: { GIT_DOWNLOAD_URL: undefined } });
    const baseUrl = getAppUrl(server.app);
    try {
      const res = await fetch(`${baseUrl}/api/config`, {
        headers: { "X-API-Key": apiKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.gitDownloadUrl).toBeNull();
    } finally {
      await server.stop();
    }
  });
});

describe("server-config — config.toml", () => {
  const apiKey = getTestApiKey();

  it("starts normally when config.toml does not exist (env vars only)", async () => {
    const server = await createTestServer();
    const baseUrl = getAppUrl(server.app);
    try {
      const res = await fetch(`${baseUrl}/api/config`, {
        headers: { "X-API-Key": apiKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.templateRepoUrl).toBe("https://github.com/example/template.git");
    } finally {
      await server.stop();
    }
  });

  it("reads templateRepoUrl from config.toml when env var is not set", async () => {
    const server = await createTestServer({
      configToml: '[template]\nrepo_url = "https://from-toml.example.com/repo.git"',
      env: { TEMPLATE_REPO_URL: undefined },
    });
    const baseUrl = getAppUrl(server.app);
    try {
      const res = await fetch(`${baseUrl}/api/config`, {
        headers: { "X-API-Key": apiKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.templateRepoUrl).toBe("https://from-toml.example.com/repo.git");
    } finally {
      await server.stop();
    }
  });

  it("env variable takes priority over config.toml", async () => {
    const server = await createTestServer({
      configToml: '[template]\nrepo_url = "https://from-toml.example.com"',
      env: { TEMPLATE_REPO_URL: "https://from-env.example.com" },
    });
    const baseUrl = getAppUrl(server.app);
    try {
      const res = await fetch(`${baseUrl}/api/config`, {
        headers: { "X-API-Key": apiKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.templateRepoUrl).toBe("https://from-env.example.com");
    } finally {
      await server.stop();
    }
  });

  it("fails to start with invalid config.toml", async () => {
    await expect(
      createTestServer({
        configToml: "this is not valid toml {{{{",
        env: { TEMPLATE_REPO_URL: undefined },
      }),
    ).rejects.toThrow(/Failed to parse/);
  });
});
