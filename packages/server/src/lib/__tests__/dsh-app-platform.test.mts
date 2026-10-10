import { Context } from "@deepseek-ai/cordis";
import ApplicationPlatform, { type ApplicationRecord } from "@localapp/dsh-app-platform";
import { expect, it } from "vitest";

it("resolves application access and capabilities without Server persistence", async () => {
  const ctx = new Context();
  let record: ApplicationRecord = { ownerId: "owner-id", offline: false, access: "private", capabilities: ["files", "skills"] };
  await ctx.plugin(ApplicationPlatform, {
    owner: (identity: string) => ["owner", "owner-id"].includes(identity) ? { id: "owner-id", name: "owner" } : undefined,
    application: (_ownerId: string, name: string) => name === "demo" ? record : undefined,
    canAccess: (_access: unknown, userId: string, ownerId: string) => userId === ownerId,
  });
  try {
    expect(ctx.localappApps.resolveAgentApp("any")).toEqual({ id: "platform", capabilities: [] });
    expect(ctx.localappApps.resolveAgentApp("owner-id", "owner-id/demo")).toEqual({ id: "owner/demo", capabilities: ["files", "skills"] });
    expect(() => ctx.localappApps.resolveAgentApp("other", "owner/demo")).toThrow("unavailable");
    expect(() => ctx.localappApps.resolveAgentApp("owner-id", "../demo")).toThrow("identity");
    record = { ...record, offline: true };
    expect(() => ctx.localappApps.resolveAgentApp("owner-id", "owner/demo")).toThrow("unavailable");
    record = { ...record, offline: false, capabilities: ["unknown"] };
    expect(() => ctx.localappApps.resolveAgentApp("owner-id", "owner/demo")).toThrow("capabilities");
    record = { ...record, get capabilities() { throw new Error("must not read a private manifest"); } };
    expect(() => ctx.localappApps.resolveAgentApp("other", "owner/demo")).toThrow("unavailable");
  } finally { await ctx.fiber.dispose(); }
});
