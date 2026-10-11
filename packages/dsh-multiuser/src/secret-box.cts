import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UNSUPPORTED_HARD_LINK_CODES = new Set(["EOPNOTSUPP", "ENOTSUP", "EPERM", "EXDEV", "EINVAL"]);

/** Encrypts short secrets with a Server-local AES-256-GCM master key. */
export class SecretBox {
  private key: Buffer | undefined;

  constructor(private readonly keyFile: string) {}

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
  }

  open(sealed: string, aad: string): string {
    try {
      const [version, ivText, ciphertextText, tagText, extra] = sealed.split(".");
      if (version !== VERSION || !ivText || !ciphertextText || !tagText || extra !== undefined) throw new Error("invalid format");
      const iv = Buffer.from(ivText, "base64url");
      const ciphertext = Buffer.from(ciphertextText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) throw new Error("invalid fields");
      const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Invalid encrypted credential");
    }
  }

  private loadKey(): Buffer {
    if (this.key) return this.key;
    const directory = path.dirname(this.keyFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(directory, `.${path.basename(this.keyFile)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let published = false;
    let adopting = false;
    try {
      const generated = randomBytes(KEY_BYTES);
      const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, generated);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (process.platform !== "win32") fs.chmodSync(temporaryPath, 0o600);
      try {
        fs.linkSync(temporaryPath, this.keyFile);
      } catch (error: unknown) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code === "EEXIST") {
          fs.rmSync(temporaryPath, { force: true });
          adopting = true;
          this.key = adoptCompleteKey(this.keyFile, directory);
          return this.key;
        }
        if (UNSUPPORTED_HARD_LINK_CODES.has(code ?? "")) {
          throw new Error("Atomic peer master-key publication is unavailable on this filesystem");
        }
        throw error;
      }
      published = true;
      fs.unlinkSync(temporaryPath);
      syncDirectory(directory);
      this.key = generated;
    } catch (error: unknown) {
      fs.rmSync(temporaryPath, { force: true });
      if (!published && !adopting && fs.existsSync(this.keyFile)) {
        adopting = true;
        this.key = adoptCompleteKey(this.keyFile, directory);
      } else {
        throw error;
      }
    }
    if (process.platform !== "win32") fs.chmodSync(this.keyFile, 0o600);
    return this.key!;
  }
}

function readCompleteKey(keyFile: string): Buffer {
  const stored = fs.readFileSync(keyFile);
  if (stored.length !== KEY_BYTES) throw new Error("Peer master key must contain exactly 32 bytes");
  if (process.platform !== "win32") fs.chmodSync(keyFile, 0o600);
  return stored;
}

function adoptCompleteKey(keyFile: string, directory: string): Buffer {
  const key = readCompleteKey(keyFile);
  syncDirectory(directory);
  return key;
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (["EINVAL", "EPERM", "EISDIR"].includes(code ?? "")) return;
    throw error;
  }
}
