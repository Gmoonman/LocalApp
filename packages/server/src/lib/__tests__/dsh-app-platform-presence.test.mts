import { EventEmitter } from "node:events";
import type { FastifyRequest, FastifyReply } from "fastify";
import { createApplicationCollaboration } from "@localapp/dsh-app-platform/collaboration-handler";
import { expect, it } from "vitest";

it("keeps formal and verification presence in separate transient channels", async () => {
  const requests: EventEmitter[] = [];
  const handlers = createApplicationCollaboration({
    visitor: () => ({ id: null, name: null }), user: () => null,
    verification: req => req.headers["x-test-verification"] ? { version: 1, databasePath: "verification-app.db" } : null,
  });
  const request = (clientId: string, verification = false) => {
    const raw = new EventEmitter(); requests.push(raw);
    return { raw, query: { clientId }, body: { clientId }, headers: verification ? { "x-test-verification": "yes" } : {} } as unknown as FastifyRequest;
  };
  const stream = () => {
    let text = "";
    return {
      reply: { raw: { writeHead() {}, end() {}, write(chunk: string) { text += chunk; } }, hijack() {} } as unknown as FastifyReply,
      latest: () => JSON.parse([...text.matchAll(/data: (.+)\n\n/g)].at(-1)![1]).data,
    };
  };
  const live = stream(); const verification = stream();
  try {
    await handlers.handlePresenceEvents(request("live"), live.reply, "owner", "demo");
    await handlers.handlePresenceEvents(request("verification", true), verification.reply, "owner", "demo");
    expect(live.latest().count).toBe(1);
    expect(verification.latest().count).toBe(1);
    handlers.handlePresenceLeaseMutation(request("live-two"), live.reply, "owner", "demo", "heartbeat");
    expect(live.latest().count).toBe(2);
    expect(verification.latest().count).toBe(1);
    handlers.dispose();
    await handlers.handlePresenceEvents(request("new-live"), live.reply, "owner", "demo");
    expect(live.latest().count).toBe(1);
  } finally { for (const raw of requests) raw.emit("close"); handlers.dispose(); }
});
