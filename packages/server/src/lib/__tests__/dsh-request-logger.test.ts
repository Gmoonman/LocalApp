import { it, expect, vi } from "vitest";
import { RequestLogger } from "@localapp/dsh-app-platform/request-logger";
import Fastify from "fastify";
import { AnalyticsStore } from "@localapp/dsh-app-platform/analytics";

it.each(["before-listen", "after-listen"])("stops HTTP logging when the platform stops %s", async phase => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: ApplicationPlatform } = await import("@localapp/dsh-app-platform");
  const requests = vi.fn();
  const logger = new RequestLogger({ insertRequestLogs: requests, insertPageViews: () => {}, onError: error => { throw error; } });
  const start = vi.spyOn(logger, "startRequestLogger");
  const analytics = new AnalyticsStore({ database: () => { throw new Error("unexpected database access"); }, flush: () => {} });
  const clean = vi.spyOn(analytics, "cleanOldLogs").mockImplementation(() => {});
  const context = new Context();
  const app = Fastify();
  try {
    await context.plugin(ApplicationPlatform, { analytics, requestLogger: logger, owner: () => undefined, application: () => undefined, canAccess: () => false });
    const platform = context.localappApps;
    platform.registerRequestLogging(app, {
      scope: "primary", identity: () => ({ userId: "alice", visitorId: null }),
    });
    for (const url of ["/api/value", "/alice/demo/api/value", "/home"]) app.get(url, async () => ({ success: true }));
    if (phase === "before-listen") await context.fiber.dispose();
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    await fetch(base + "/api/value?apiKey=private-query-value");
    await fetch(base + "/alice/demo/api/value");
    await fetch(base + "/home");
    const records = logger.listRecentRequestLogs("primary");
    if (phase === "after-listen") {
      expect(records).toEqual([
        expect.objectContaining({ path: "/alice/demo/api/value", userId: "alice" }),
        expect.objectContaining({ path: "/api/value", userId: "alice" }),
      ]);
      expect(start).toHaveBeenCalledOnce();
      expect(clean).toHaveBeenCalledOnce();
    } else {
      expect(records).toEqual([]);
      expect(start).not.toHaveBeenCalled();
      expect(clean).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(records)).not.toContain("private-query-value");
    expect(logger.listRecentRequestLogs("other")).toEqual([]);
    await context.fiber.dispose();
    await fetch(base + "/api/value");
    expect(logger.listRecentRequestLogs("primary")).toEqual(records);
    expect(() => platform.registerRequestLogging(app, undefined as never)).toThrow("plugin is stopped");
  } finally { await app.close(); await context.fiber.dispose(); vi.restoreAllMocks(); }
});

it("flushes buffered records and clears its timer when the platform plugin stops", async () => {
  vi.useFakeTimers();
  const requests = vi.fn();
  const views = vi.fn();
  const onError = vi.fn();
  const logger = new RequestLogger({ insertRequestLogs: requests, insertPageViews: views, onError });
  const { Context } = await import("@deepseek-ai/cordis");
  const { default: ApplicationPlatform } = await import("@localapp/dsh-app-platform");
  const context = new Context();
  try {
    await context.plugin(ApplicationPlatform, { requestLogger: logger, owner: () => undefined, application: () => undefined, canAccess: () => false });
    const entry = { path: "/api/test", method: "GET", status: 200, durationMs: 1, userId: "user", visitorId: null };
    logger.startRequestLogger();
    logger.startRequestLogger();
    expect(vi.getTimerCount()).toBe(1);
    logger.pushRequestLog(entry, "server");
    logger.pushPageView({ pagePath: "/user/app", visitorId: null, userId: "user" });
    await context.fiber.dispose();
    expect(requests).toHaveBeenCalledWith([entry]);
    expect(views).toHaveBeenCalledWith([{ pagePath: "/user/app", visitorId: null, userId: "user" }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.listRecentRequestLogs("other")).toEqual([]);
    expect(logger.listRecentRequestLogs("server")).toEqual([entry]);
    expect(onError).not.toHaveBeenCalled();
  } finally { await context.fiber.dispose(); vi.useRealTimers(); }
});

it("reports background storage errors through the host", () => {
  const failure = new Error("storage unavailable");
  const onError = vi.fn();
  const logger = new RequestLogger({ insertRequestLogs: () => { throw failure; }, insertPageViews: () => {}, onError });
  logger.stopRequestLogger();
  expect(onError).toHaveBeenCalledWith(failure);
});
