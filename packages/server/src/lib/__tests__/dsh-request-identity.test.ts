import { expect, it, vi } from "vitest";
import { resolveRequestUser, resolveAdministrator } from "@localapp/dsh-multiuser/request-identity";

it("does not let a browser session override an invalid application API key", () => {
  const validateApiKey = vi.fn(() => undefined);
  expect(resolveRequestUser({ apiKey: "expired", visitorId: "browser-user" }, { validateApiKey }))
    .toEqual({ ok: false, reason: "invalid-api-key" });
  expect(resolveRequestUser({ apiKey: undefined, visitorId: "browser-user" }, { validateApiKey }))
    .toEqual({ ok: true, userId: "browser-user" });
  expect(validateApiKey).toHaveBeenCalledTimes(1);
});

it("checks the administrator role on every request including session fallback", () => {
  let role = "admin";
  const lookup = { validateApiKey: () => undefined, getUserRole: vi.fn(() => role) };
  const credentials = { apiKey: "expired", visitorId: "browser-user" };
  expect(resolveAdministrator(credentials, lookup)).toEqual({ ok: true, userId: "browser-user" });
  role = "user";
  expect(resolveAdministrator(credentials, lookup)).toEqual({ ok: false, status: 403, error: "Admin access required" });
  expect(resolveAdministrator({ apiKey: undefined }, lookup)).toEqual({ ok: false, status: 401, error: "Authentication required" });
});
