import { AUTH_SESSION_MAX_AGE_SECONDS } from "./auth-sessions.cjs";
interface CookieRequest { raw: { socket: object } }
interface CookieReply {
  setCookie(name: string, value: string, options: { httpOnly: boolean; sameSite: "lax"; path: string; secure: boolean; maxAge: number; expires: Date }): unknown;
  clearCookie(name: string, options: { path: string; secure: boolean }): unknown;
}

function isSecureRequest(req: CookieRequest): boolean {
  return process.env.NODE_ENV === "production"
    || (req.raw.socket as { encrypted?: boolean }).encrypted === true;
}

export function setAuthSessionCookie(
  req: CookieRequest,
  reply: CookieReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureRequest(req),
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    expires: expiresAt,
  });
}

export function clearAuthSessionCookie(req: CookieRequest, reply: CookieReply): void {
  reply.clearCookie("token", {
    path: "/",
    secure: isSecureRequest(req),
  });
}
