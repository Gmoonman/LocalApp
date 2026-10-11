import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createTestUser } from "../helpers/createUser.js";
import { createTestPage, createTestServer } from "./helpers.js";
import { parseDeviceActivationUrl } from "../../src/lib/device-action-ticket.js";

describe("generic device action source protocol", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let stop: () => Promise<void>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  const fixtureDirectory = path.resolve(process.cwd(), "../../tmp/device-action-e2e");

  beforeAll(async () => {
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
    await fs.mkdir(fixtureDirectory, { recursive: true });
    const server = await createTestServer();
    app = server.app;
    baseUrl = server.baseUrl;
    stop = server.stop;
    user = await createTestUser(baseUrl, "deviceactionowner");
    await createTestPage(app, "deviceactionowner", "automation");
  });

  afterAll(async () => {
    await stop();
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
  });

  it("creates a canonical ticket and exposes no executable fields in browser snapshots", async () => {
    const create = await fetch(`${baseUrl}/serve/deviceactionowner/automation/api/device-actions`, {
      method: "POST",
      headers: {
        cookie: user.cookie,
        referer: `${baseUrl}/deviceactionowner/automation/`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Install fixture",
        description: "Write a fixture file",
        script: "await import('node:fs/promises').then(({writeFile}) => writeFile(input.path, input.content)); return { installed: true };",
        input: { path: path.join(fixtureDirectory, "installed.txt"), content: "fixture" },
        permissions: { filesystemWrite: [fixtureDirectory] },
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()).data as { requestId: string; activationUrl: string; protocolVersion: number };
    expect(created.protocolVersion).toBe(2);
    const ticket = parseDeviceActivationUrl(created.activationUrl);
    expect(ticket.sourceOrigin).toBe(baseUrl);

    const browserSnapshot = await fetch(`${baseUrl}/api/device-actions/${created.requestId}`, { headers: { cookie: user.cookie } });
    expect(browserSnapshot.status).toBe(200);
    const snapshot = (await browserSnapshot.json()).data as Record<string, unknown>;
    expect(snapshot).toMatchObject({ id: created.requestId, status: "pending", permissions: { filesystemWrite: [fixtureDirectory] } });
    for (const secret of ["script", "dependencies", "input", "nonce", "installationId"]) {
      expect(snapshot).not.toHaveProperty(secret);
    }
  });

  it("claims and updates a source action with only the activation nonce", async () => {
    const create = await fetch(`${baseUrl}/serve/deviceactionowner/automation/api/device-actions`, {
      method: "POST",
      headers: { cookie: user.cookie, referer: `${baseUrl}/deviceactionowner/automation/`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Run fixture", script: "return { ok: true };", permissions: {} }),
    });
    const created = (await create.json()).data as { requestId: string; activationUrl: string };
    const ticket = parseDeviceActivationUrl(created.activationUrl);
    const installationId = "11111111-1111-4111-8111-111111111111";
    const claim = await fetch(`${baseUrl}/api/device-actions/${created.requestId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ticket, installationId }),
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()).data as { callbackToken: string; action: Record<string, unknown> };
    expect(claimed.callbackToken).toBe(ticket.nonce);
    expect(claimed.action).toMatchObject({ id: created.requestId, script: "return { ok: true };" });

    const replay = await fetch(`${baseUrl}/api/device-actions/${created.requestId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ticket, installationId }),
    });
    expect(replay.status).toBe(200);

    const status = async (value: string) => fetch(`${baseUrl}/api/device-actions/${created.requestId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 2, installationId, callbackToken: claimed.callbackToken, status: value }),
    });
    const disconnect = new AbortController();
    const stream = await fetch(`${baseUrl}/api/device-actions/${created.requestId}/events`, {
      headers: { cookie: user.cookie },
      signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(5000)]),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let events = "";
    try {
      events += decoder.decode((await reader.read()).value);
      expect(events).toContain('"status":"claimed"');
      expect((await status("preparing")).status).toBe(200);
      expect((await status("running")).status).toBe(200);
      while (!events.includes('"status":"running"')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        events += decoder.decode(chunk.value);
      }
      expect(events).toContain("event: device:action-updated");
      expect(events).not.toContain('"nonce":');
      expect(events).not.toContain('"script":');
      expect((await status("succeeded")).status).toBe(200);
    } finally {
      disconnect.abort();
      await reader.cancel().catch(() => {});
    }

    const completed = await fetch(`${baseUrl}/api/device-actions/${created.requestId}`, { headers: { cookie: user.cookie } });
    expect((await completed.json()).data).toMatchObject({ status: "succeeded" });
    const wrongInstallation = await fetch(`${baseUrl}/api/device-actions/${created.requestId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ticket, installationId: "22222222-2222-4222-8222-222222222222" }),
    });
    expect(wrongInstallation.status).toBe(409);
  });

  it("does not consume a nonce when the ticket source origin is wrong", async () => {
    const create = await fetch(`${baseUrl}/serve/deviceactionowner/automation/api/device-actions`, {
      method: "POST",
      headers: { cookie: user.cookie, referer: `${baseUrl}/deviceactionowner/automation/`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Origin check", script: "return { ok: true };", permissions: {} }),
    });
    const created = (await create.json()).data as { requestId: string; activationUrl: string };
    const ticket = parseDeviceActivationUrl(created.activationUrl);
    const installationId = "33333333-3333-4333-8333-333333333333";
    const wrongOrigin = await fetch(`${baseUrl}/api/device-actions/${created.requestId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ticket, sourceOrigin: "http://wrong-origin.example", installationId }),
    });
    expect(wrongOrigin.status).toBe(404);

    const claim = await fetch(`${baseUrl}/api/device-actions/${created.requestId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ticket, installationId }),
    });
    expect(claim.status).toBe(200);
  });
});
