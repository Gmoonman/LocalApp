import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../src/lib/secret-box.js";

const directories: string[] = [];

function createKeyFile(): string {
  const parent = path.resolve(__dirname, "../../../tmp/secret-box-tests");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "keys-"));
  directories.push(directory);
  return path.join(directory, "master.key");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("SecretBox", () => {
  it("encrypts credentials with authenticated peer-specific additional data", () => {
    const keyFile = createKeyFile();
    const box = new SecretBox(keyFile);
    const sealed = box.seal("peer-api-key-that-must-not-leak", "peer-a");

    expect(sealed).not.toContain("peer-api-key-that-must-not-leak");
    expect(box.open(sealed, "peer-a")).toBe("peer-api-key-that-must-not-leak");
    expect(() => box.open(sealed, "peer-b")).toThrow("Invalid encrypted credential");
  });

  it("rejects ciphertext tampering and creates its master key with restrictive permissions", () => {
    const keyFile = createKeyFile();
    const box = new SecretBox(keyFile);
    const sealed = box.seal("peer-api-key-that-must-not-leak", "peer-a");
    const [version, iv, ciphertext, tag] = sealed.split(".");
    const replacement = tag.startsWith("A") ? "B" : "A";
    const tampered = `${version}.${iv}.${ciphertext}.${replacement}${tag.slice(1)}`;

    expect(() => box.open(tampered, "peer-a")).toThrow("Invalid encrypted credential");
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
  });

  it("never exposes an empty final key while publishing the first master key", () => {
    const keyFile = createKeyFile();
    const writeFileSync = fs.writeFileSync;
    let observedEmptyFinalKey = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      if (fs.existsSync(keyFile) && fs.statSync(keyFile).size === 0) observedEmptyFinalKey = true;
      return writeFileSync(...args);
    }) as typeof fs.writeFileSync);

    new SecretBox(keyFile).seal("peer-api-key-that-must-not-leak", "peer-a");

    expect(observedEmptyFinalKey).toBe(false);
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
  });

  it("adopts a complete key published by a concurrent first creator without a stale lock", () => {
    const keyFile = createKeyFile();
    const linkSync = fs.linkSync;
    const fsyncSync = fs.fsyncSync;
    let simulatedRace = false;
    let fsyncCalls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation(((descriptor: number) => {
      fsyncCalls += 1;
      return fsyncSync(descriptor);
    }) as typeof fs.fsyncSync);
    vi.spyOn(fs, "linkSync").mockImplementation(((temporaryPath: fs.PathLike, finalPath: fs.PathLike) => {
      linkSync(temporaryPath, finalPath);
      simulatedRace = true;
      const error = Object.assign(new Error("already published"), { code: "EEXIST" });
      throw error;
    }) as typeof fs.linkSync);

    const first = new SecretBox(keyFile);
    const sealed = first.seal("peer-api-key-that-must-not-leak", "peer-a");

    expect(simulatedRace).toBe(true);
    expect(fsyncCalls).toBe(2);
    const concurrent = new SecretBox(keyFile);
    expect(concurrent.open(sealed, "peer-a")).toBe("peer-api-key-that-must-not-leak");
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
    expect(fs.readdirSync(path.dirname(keyFile)).filter((entry) => entry.endsWith(".lock"))).toEqual([]);
  });

  it("propagates an adopting creator's directory-sync failure without retrying adoption", () => {
    const keyFile = createKeyFile();
    const linkSync = fs.linkSync;
    const fsyncSync = fs.fsyncSync;
    let fsyncCalls = 0;
    vi.spyOn(fs, "linkSync").mockImplementation(((temporaryPath: fs.PathLike, finalPath: fs.PathLike) => {
      linkSync(temporaryPath, finalPath);
      throw Object.assign(new Error("already published"), { code: "EEXIST" });
    }) as typeof fs.linkSync);
    vi.spyOn(fs, "fsyncSync").mockImplementation(((descriptor: number) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) throw Object.assign(new Error("adopt directory sync failed"), { code: "EIO" });
      return fsyncSync(descriptor);
    }) as typeof fs.fsyncSync);

    expect(() => new SecretBox(keyFile).seal("peer-api-key-that-must-not-leak", "peer-a"))
      .toThrow("adopt directory sync failed");
    expect(fsyncCalls).toBe(2);
  });

  it("fails closed when the parent-directory fsync cannot durably publish the key", () => {
    const keyFile = createKeyFile();
    const fsyncSync = fs.fsyncSync;
    let fsyncCount = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation(((descriptor: number) => {
      fsyncCount += 1;
      if (fsyncCount === 2) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      return fsyncSync(descriptor);
    }) as typeof fs.fsyncSync);

    expect(() => new SecretBox(keyFile).seal("peer-api-key-that-must-not-leak", "peer-a"))
      .toThrow("directory sync failed");
  });

  it("fails closed for a genuinely pre-existing malformed master key", () => {
    const keyFile = createKeyFile();
    fs.writeFileSync(keyFile, Buffer.alloc(31));

    expect(() => new SecretBox(keyFile).seal("peer-api-key-that-must-not-leak", "peer-a"))
      .toThrow("Peer master key must contain exactly 32 bytes");
  });
});
