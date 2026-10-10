export interface NativeClientScope { appId: string; providerId: string }

function validate(value: unknown): NativeClientScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native client scope");
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2 || typeof scope.appId !== "string" || scope.appId.length > 256 ||
    scope.appId !== "platform" && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(scope.appId) ||
    typeof scope.providerId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(scope.providerId)) throw new Error("Invalid native client scope");
  return { appId: scope.appId, providerId: scope.providerId };
}

/** Public routing data only. Server authentication still determines the user. */
export function encodeNativeScope(scope: NativeClientScope): string {
  return Buffer.from(JSON.stringify(validate(scope))).toString("base64url");
}
export function decodeNativeScope(encoded: string): NativeClientScope {
  if (encoded.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(encoded)) throw new Error("Invalid native client scope");
  const scope = validate(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  if (encodeNativeScope(scope) !== encoded) throw new Error("Invalid native client scope");
  return scope;
}
