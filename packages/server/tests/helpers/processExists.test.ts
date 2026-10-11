import { afterEach, expect, it, vi } from "vitest";
import { processExists } from "./processExists.js";
afterEach(() => vi.restoreAllMocks());
it.each(["EPERM", "ESRCH"])("distinguishes existence from signal permission: %s", code => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(code), {code}); });
  expect(processExists(42)).toBe(code === "EPERM");
});
it("does not hide other errors", () => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("EINVAL"), {code:"EINVAL"}); });
  expect(() => processExists(42)).toThrow("EINVAL");
});
