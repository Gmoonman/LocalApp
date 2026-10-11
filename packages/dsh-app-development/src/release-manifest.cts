export type ReleaseAssetKind = "cli" | "desktop";
export type ReleaseSignatureStatus = "signed" | "ad-hoc" | "unsigned" | "not-applicable";

export interface ReleaseAsset {
  kind: ReleaseAssetKind;
  version: string;
  os: string;
  arch: string;
  filename: string;
  url: string;
  size: number;
  sha256: string;
  signature: ReleaseSignatureStatus;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  latest: string;
  min: string;
  generatedAt: string;
  assets: ReleaseAsset[];
}

export interface ReleaseManifestSnapshot {
  manifest: ReleaseManifest;
  fetchedAt: number;
  stale: boolean;
}

export interface ReleaseManifestProvider {
  get(): Promise<ReleaseManifestSnapshot>;
}

export class ReleaseManifestError extends Error {
  constructor(
    public readonly code:
      | "CLI_RELEASE_MANIFEST_INVALID"
      | "CLI_RELEASE_MANIFEST_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ReleaseManifestError";
  }
}

interface ReleaseManifestClientOptions {
  manifestUrl: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  maxBytes?: number;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RELEASE_ASSET_BYTES = 512 * 1024 * 1024;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export class ReleaseManifestClient implements ReleaseManifestProvider {
  private readonly manifestUrl: string;
  private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly cacheTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly requestTimeoutMs: number;
  private cache?: Omit<ReleaseManifestSnapshot, "stale">;

  constructor(options: ReleaseManifestClientOptions) {
    this.manifestUrl = options.manifestUrl;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async get(): Promise<ReleaseManifestSnapshot> {
    if (!this.manifestUrl.trim()) {
      throw new ReleaseManifestError(
        "CLI_RELEASE_MANIFEST_UNAVAILABLE",
        "no CLI release manifest URL is configured",
      );
    }
    const sourceUrl = parseHttpsUrl(this.manifestUrl, "manifest URL");
    const now = this.now();
    if (this.cache && now - this.cache.fetchedAt <= this.cacheTtlMs) {
      return { ...this.cache, stale: false };
    }

    try {
      const response = await this.fetcher(sourceUrl.href, {
        redirect: "follow",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`manifest request returned ${response.status}`);
      }
      if (response.url) {
        parseHttpsUrl(response.url, "manifest response URL");
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
        throw new ReleaseManifestError(
          "CLI_RELEASE_MANIFEST_INVALID",
          "release manifest exceeds the configured byte limit",
        );
      }
      const body = await readBoundedBody(response, this.maxBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new ReleaseManifestError(
          "CLI_RELEASE_MANIFEST_INVALID",
          "release manifest is not valid JSON",
        );
      }
      const manifest = validateReleaseManifest(parsed, sourceUrl);
      this.cache = { manifest, fetchedAt: now };
      return { ...this.cache, stale: false };
    } catch (error) {
      if (this.cache && now - this.cache.fetchedAt <= this.staleTtlMs) {
        return { ...this.cache, stale: true };
      }
      if (error instanceof ReleaseManifestError) throw error;
      throw new ReleaseManifestError(
        "CLI_RELEASE_MANIFEST_UNAVAILABLE",
        "no validated CLI release manifest is currently available",
      );
    }
  }
}

export function findCliAsset(
  manifest: ReleaseManifest,
  target: { version: string; os: string; arch: string },
): ReleaseAsset | undefined {
  return manifest.assets.find(
    (asset) =>
      asset.kind === "cli"
      && asset.version === target.version
      && asset.os === target.os
      && asset.arch === target.arch,
  );
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ReleaseManifestError(
        "CLI_RELEASE_MANIFEST_INVALID",
        "release manifest exceeds the configured byte limit",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validateReleaseManifest(value: unknown, sourceUrl: URL): ReleaseManifest {
  if (!isRecord(value)) return invalid("release manifest must be an object");
  assertExactKeys(value, ["schemaVersion", "latest", "min", "generatedAt", "assets"]);
  if (value.schemaVersion !== 1) return invalid("unsupported release manifest schema");
  if (!isSemver(value.latest) || !isSemver(value.min)) {
    return invalid("release versions must be semantic versions");
  }
  if (
    typeof value.generatedAt !== "string"
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.assets)
    || value.assets.length === 0
  ) {
    return invalid("release manifest metadata is incomplete");
  }

  const seen = new Set<string>();
  const assets = value.assets.map((candidate) => {
    if (!isRecord(candidate)) return invalid("release asset must be an object");
    assertExactKeys(candidate, [
      "kind",
      "version",
      "os",
      "arch",
      "filename",
      "url",
      "size",
      "sha256",
      "signature",
    ]);
    if (!["cli", "desktop"].includes(String(candidate.kind))) return invalid("invalid asset kind");
    if (!isSemver(candidate.version)) return invalid("invalid asset version");
    if (
      typeof candidate.os !== "string"
      || typeof candidate.arch !== "string"
      || !SAFE_NAME_PATTERN.test(candidate.os)
      || !SAFE_NAME_PATTERN.test(candidate.arch)
      || typeof candidate.filename !== "string"
      || !SAFE_NAME_PATTERN.test(candidate.filename)
    ) {
      return invalid("invalid asset target or filename");
    }
    const assetUrl = parseHttpsUrl(candidate.url, "asset URL");
    if (assetUrl.origin !== sourceUrl.origin) return invalid("asset URL has an untrusted origin");
    if (
      !Number.isSafeInteger(candidate.size)
      || Number(candidate.size) <= 0
      || Number(candidate.size) > MAX_RELEASE_ASSET_BYTES
    ) {
      return invalid("asset size is outside the supported range");
    }
    if (typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
      return invalid("asset SHA-256 is invalid");
    }
    if (!["signed", "ad-hoc", "unsigned", "not-applicable"].includes(String(candidate.signature))) {
      return invalid("asset signature status is invalid");
    }
    const key = `${candidate.kind}:${candidate.version}:${candidate.os}:${candidate.arch}`;
    if (seen.has(key)) return invalid("release manifest contains a duplicate target");
    seen.add(key);
    return candidate as unknown as ReleaseAsset;
  });

  return {
    schemaVersion: 1,
    latest: value.latest,
    min: value.min,
    generatedAt: value.generatedAt,
    assets,
  };
}

function parseHttpsUrl(value: unknown, label: string): URL {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url;
  } catch {
    throw new ReleaseManifestError(
      "CLI_RELEASE_MANIFEST_INVALID",
      `${label} must be an HTTPS URL without embedded credentials`,
    );
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    invalid("release manifest contains unknown or missing fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

function invalid(message: string): never {
  throw new ReleaseManifestError("CLI_RELEASE_MANIFEST_INVALID", message);
}
