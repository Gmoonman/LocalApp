import { createHash, randomBytes } from "node:crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SetupTokenStore {
  private readonly tokens = new Map<string, number>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  issue(now = Date.now()): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.tokens.set(hashToken(token), expiresAt);
    return { token, expiresAt };
  }

  consume(token: string, now = Date.now()): boolean {
    const key = hashToken(token);
    const expiresAt = this.tokens.get(key);
    this.tokens.delete(key);
    return expiresAt !== undefined && expiresAt > now;
  }

  revokeAll(): void {
    this.tokens.clear();
  }
}
