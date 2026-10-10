import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import MultiuserRuntime from "../../../../dsh-multiuser/src/index.mjs";
const identity = { userId: "alice", applicationId: "app", role: "user" as const, providerId: "model" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function runtime() { return { close: vi.fn(async () => {}) }; }
async function mount(capacity = 100) {
  const ctx = new Context(); ctx.plugin(MultiuserRuntime, { capacity }); await ctx.start();
  return { ctx, service: ctx.localappMultiuser };
}
describe("dsh multiuser runtime plugin", () => {
  it("separates users, applications, roles and providers", async () => {
    const { ctx, service } = await mount();
    try {
      const first = await service.acquire(identity, "v1", async () => runtime());
      expect(await service.acquire(identity, "v1", async () => runtime())).toBe(first);
      for (const changed of [{ userId: "bob" }, { applicationId: "other" }, { role: "developer" as const }, { providerId: "other" }]) {
        expect(await service.acquire({ ...identity, ...changed }, "v1", async () => runtime())).not.toBe(first);
      }
      expect(service.forUser("bob")).toHaveLength(1);
      expect(service.forUser("unknown")).toHaveLength(0);
    } finally { await ctx.stop(); }
  });
  it("shares initialization and reserves capacity before the factory finishes", async () => {
    const { ctx, service } = await mount(1); const pending = deferred<ReturnType<typeof runtime>>(); const factory = vi.fn(() => pending.promise);
    const first = service.acquire(identity, "v1", factory); const second = service.acquire(identity, "v1", factory);
    await expect(service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime())).rejects.toThrow("capacity");
    const value = runtime(); pending.resolve(value);
    expect(await first).toBe(value); expect(await second).toBe(value); expect(factory).toHaveBeenCalledTimes(1);
    await ctx.stop(); expect(value.close).toHaveBeenCalledTimes(1);
  });
  it("closes old configuration before replacement and releases failed capacity", async () => {
    const { ctx, service } = await mount(1);
    try {
      const old = await service.acquire(identity, "v1", async () => runtime());
      await expect(service.acquire(identity, "v2", async () => { expect(old.close).toHaveBeenCalledTimes(1); throw new Error("failed"); })).rejects.toThrow("failed");
      await service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime());
    } finally { await ctx.stop(); }
  });
  it("invalidates pending creation only for the selected user and application", async () => {
    const { ctx, service } = await mount(); const pending = deferred<ReturnType<typeof runtime>>();
    const opening = service.acquire(identity, "v1", () => pending.promise);
    const rejected = expect(opening).rejects.toThrow("invalidated");
    const other = await service.acquire({ ...identity, userId: "bob" }, "v1", async () => runtime());
    const closing = service.invalidate("alice", "app"); const value = runtime(); pending.resolve(value);
    await closing; await rejected; expect(value.close).toHaveBeenCalledTimes(1); expect(other.close).not.toHaveBeenCalled();
    expect(service.forUser("alice")).toHaveLength(0);
    await ctx.stop();
  });
  it("disposes late creation and refuses new work after Cordis stops", async () => {
    const { ctx, service } = await mount(); const pending = deferred<ReturnType<typeof runtime>>();
    const opening = service.acquire(identity, "v1", () => pending.promise); const rejected = expect(opening).rejects.toThrow("invalidated");
    const closing = ctx.stop(); await Promise.resolve(); const value = runtime(); pending.resolve(value);
    await closing; await rejected; expect(value.close).toHaveBeenCalledTimes(1);
    await expect(service.acquire(identity, "v1", async () => runtime())).rejects.toThrow("closed");
  });
});
