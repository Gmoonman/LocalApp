import net from "node:net";
import type { PeerVerification } from "./peer-store.cjs";

export interface NormalizedPeerUrl {
  baseUrl: string;
  acceptInsecureHttp: boolean;
}

interface CapabilityResponse {
  protocolVersion: unknown;
  user: { id?: unknown; name?: unknown; displayName?: unknown } | undefined;
  transferLimits: unknown;
}

export function normalizePeerUrl(input: string, acceptInsecureHttp: boolean): NormalizedPeerUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Peer URL must be an absolute HTTPS URL");
  }
  if (url.username || url.password || url.hash || url.search) throw new Error("Peer URL cannot contain credentials, fragments, or query parameters");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Peer URL must use HTTPS");
  if (url.protocol === "http:" && (!acceptInsecureHttp || !isPrivateOrLoopbackHost(url.hostname))) {
    throw new Error("HTTP peer URLs require explicit acknowledgement and a loopback or private-LAN host");
  }
  const suffix = url.pathname.replace(/\/+$/, "");
  return { baseUrl: `${url.origin}${suffix}`, acceptInsecureHttp: url.protocol === "http:" };
}

export async function checkPeerCapabilities(baseUrl: string, apiKey: string): Promise<PeerVerification> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/peer/capabilities`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Peer capability check failed");
  }
  const body = await response.json().catch(() => null) as { success?: unknown; data?: CapabilityResponse } | null;
  if (!response.ok || !body?.success || !body.data) throw new Error("Peer capability check failed");
  const { protocolVersion, user, transferLimits } = body.data;
  if (
    !Number.isSafeInteger(protocolVersion) || (protocolVersion as number) < 1
    || !user || typeof user.id !== "string" || !user.id || typeof user.name !== "string" || !user.name
    || (user.displayName !== null && user.displayName !== undefined && typeof user.displayName !== "string")
    || !isNumericRecord(transferLimits)
  ) throw new Error("Peer returned invalid capabilities");
  return {
    protocolVersion: protocolVersion as number,
    user: { id: user.id, name: user.name, displayName: typeof user.displayName === "string" ? user.displayName : null },
    transferLimits: transferLimits as Record<string, number>,
  };
}

function isNumericRecord(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0);
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return family === 6 && (/^(fc|fd|fe80:)/i.test(host));
}
