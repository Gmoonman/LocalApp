import type { FastifyInstance, FastifyRequest } from "fastify";

export interface IdentityLookup {
  validateApiKey(key: string): string | null | undefined;
  getUserRole(userId: string): string | null | undefined;
}

export interface AuthenticationRoutesHost extends IdentityLookup {
  visitorId(request: FastifyRequest): string | null | undefined;
  setUserId(request: FastifyRequest, userId: string): void;
}

export function registerUserAuthentication(app: FastifyInstance, host: AuthenticationRoutesHost): void {
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request, reply) => {
    const resolution = resolveRequestUser({ apiKey: request.headers["x-api-key"], visitorId: host.visitorId(request) }, host);
    if (resolution.ok) { host.setUserId(request, resolution.userId); return; }
    return reply.status(401).send({ success: false, error: resolution.reason === "invalid-api-key" ? "Invalid API key" : "API key required" });
  });
}

export function registerAdministratorAuthentication(app: FastifyInstance, host: AuthenticationRoutesHost): void {
  app.addHook("onRequest", async (request, reply) => {
    const resolution = resolveAdministrator({ apiKey: request.headers["x-api-key"], visitorId: host.visitorId(request) }, host);
    if (!resolution.ok) return reply.status(resolution.status).send({ success: false, error: resolution.error });
    host.setUserId(request, resolution.userId);
  });
}
export interface RequestCredentials {
  apiKey: unknown;
  visitorId?: string | null;
}
export type RequestUserResolution =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid-api-key" | "missing-credentials" };

/** API credentials take precedence over a browser session for application requests. */
export function resolveRequestUser(credentials: RequestCredentials, lookup: Pick<IdentityLookup, "validateApiKey">): RequestUserResolution {
  if (typeof credentials.apiKey === "string") {
    const userId = lookup.validateApiKey(credentials.apiKey);
    return userId ? { ok: true, userId } : { ok: false, reason: "invalid-api-key" };
  }
  return credentials.visitorId
    ? { ok: true, userId: credentials.visitorId }
    : { ok: false, reason: "missing-credentials" };
}

/** Preserve the administrator entry's existing browser-session fallback. */
export function resolveAdministrator(credentials: RequestCredentials, lookup: IdentityLookup):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string } {
  const userId = (typeof credentials.apiKey === "string" && credentials.apiKey
    ? lookup.validateApiKey(credentials.apiKey) : undefined) || credentials.visitorId;
  if (!userId) return { ok: false, status: 401, error: "Authentication required" };
  if (lookup.getUserRole(userId) !== "admin") return { ok: false, status: 403, error: "Admin access required" };
  return { ok: true, userId };
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

const SKIP_VERSION_CHECK = ["/api/cli/version", "/api/cli/download"];

export function registerCliVersionCheck(app: FastifyInstance, host: { minVersion?: string; visitorId(request: FastifyRequest): string | null | undefined }) {
  const minVersion = host.minVersion;
  if (!minVersion) return;

  app.addHook("onRequest", async (req, reply) => {
    if (SKIP_VERSION_CHECK.includes(req.routeOptions.url ?? "")) {
      return;
    }

    // Skip version check for session-authenticated requests (browser access)
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey && host.visitorId(req)) {
      return;
    }

    const cliVersion = req.headers["x-cli-version"] as string | undefined;
    if (!cliVersion) {
      return reply.status(403).send({
        success: false,
        error: "CLI version unknown. Run `localapp update` to upgrade.",
      });
    }

    if (compareVersions(cliVersion, minVersion!) < 0) {
      return reply.status(403).send({
        success: false,
        error: `CLI version ${cliVersion} is outdated. Minimum required: ${minVersion}. Run \`localapp update\` to upgrade.`,
      });
    }
  });
}
