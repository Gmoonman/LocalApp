import { it, expect, vi } from "vitest";
import path from "node:path";
import { SystemEnvironment } from "@localapp/dsh-execution-environment/system-environment";
import type { AgentEnvironment } from "@localapp/dsh-execution-environment/agent-environment";

it("shares concurrent probes, retries failed initialization and closes every harness", async () => {
  const root = path.resolve(process.cwd(), "../../tmp/system-environment-cache-test");
  const close = vi.fn(async () => {});
  const initialize = vi.fn(async (): Promise<void> => { throw new Error("probe initialization failed"); });
  const report: AgentEnvironment = { checkedAt: "now", platform: "test", ready: true, checks: [] };
  const createHarness = vi.fn(async () => ({ initialize, close, checkEnvironment: async () => report }));
  const service = new SystemEnvironment({ createHarness });
  const first = service.check(root);
  const second = service.check(root);
  const failed = await Promise.allSettled([first, second]);
  expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(createHarness).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  initialize.mockImplementation(async () => {});
  expect(await service.check(root)).toEqual(report);
  expect(await service.check(root)).toEqual(report);
  expect(createHarness).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it("waits for pending environment probes on Cordis disposal and does not restore their cache", async () => {
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const close = vi.fn(async () => {});
  const report: AgentEnvironment = { checkedAt: "now", platform: "test", ready: true, checks: [] };
  const createHarness = vi.fn(async () => ({ close, initialize: async () => { started(); await pending; }, checkEnvironment: async () => report }));
  const service = new SystemEnvironment({ createHarness });
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: MultiuserRuntime } = await import("@localapp/dsh-multiuser");
  const context = new Context();
  await context.plugin(MultiuserRuntime, { systemEnvironment: service });
  const root = path.resolve(process.cwd(), "../../tmp/system-environment-disposal-test");
  const probe = service.check(root);
  await ready;
  const drain = vi.spyOn(service, "drain");
  const disposal = context.fiber.dispose();
  try {
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    await expect(service.check(root)).rejects.toThrow("Environment checks are stopping");
    expect(close).not.toHaveBeenCalled();
  } finally { finish(); await probe; await disposal; }
  expect(close).toHaveBeenCalledTimes(1);
  await service.check(root);
  expect(createHarness).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
