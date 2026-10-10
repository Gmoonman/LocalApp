import { encodeNativeScope, decodeNativeScope } from "@localapp/dsh-multiuser/native-scope";
import { expect, it } from "vitest";

it("pins native requests to an application and configured provider, without carrying an actor", () => {
  const scope = { appId: "owner/application", providerId: "model-one" };
  expect(decodeNativeScope(encodeNativeScope(scope))).toEqual(scope);
  expect(() => decodeNativeScope(Buffer.from(JSON.stringify({ ...scope, userId: "another-user" })).toString("base64url"))).toThrow();
  expect(() => decodeNativeScope("x".repeat(1025))).toThrow();
  expect(() => decodeNativeScope("invalid")).toThrow();
});
