import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_ROOT_FILES = new Set([
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "Dockerfile",
  "LICENSE",
  "README.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docker-compose.yml",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
]);
const ALLOWED_PREFIXES = [
  ".github/",
  "assets/brand/",
  "benchmarks/agent-first-run/README.md",
  "benchmarks/agent-first-run/baselines/",
  "benchmarks/agent-first-run/catalog.json",
  "benchmarks/agent-first-run/deterministic-suite.json",
  "benchmarks/agent-first-run/schemas/",
  "deploy/",
  "docs/issue-workspace.md",
  "docs/local-runtime.md",
  "docs/npm-release.md",
  "docs/open-source-release.md",
  "docs/plan.md",
  "docs/windows-local-release.md",
  "init-repo/",
  "openspec/changes/archive/",
  "openspec/config.yaml",
  "openspec/specs/",
  "packages/",
  "platform/",
  "scripts/",
];
const DENIED_PREFIXES = [
  "packages/server/static/cli/",
  "packages/server/static/profile/",
];
const DENIED_EXTENSIONS = new Set([
  ".7z", ".apk", ".app", ".appimage", ".bz2", ".cab", ".deb", ".dmg", ".dll",
  ".dylib", ".exe", ".gz", ".img", ".iso", ".jar", ".msi", ".node", ".pfx",
  ".pkg", ".rar", ".rpm", ".so", ".tar", ".tgz", ".war", ".whl", ".xz", ".zip",
  ".zst",
]);
const SAFE_CREDENTIAL_MARKERS = [
  "change-me",
  "example",
  "placeholder",
  "replace-with",
  "test-",
  "test_",
];
const PRIVATE_IDENTITY_MARKERS = ["pato" + "do"];
const SCAN_BASELINE_PATH = "scripts/public-source-scan-baseline.json";
const CANONICAL_PUBLIC_REPOSITORY_URL = /(?:git\+)?https:\/\/github\.com\/Patodo\/LocalApp(?:\.git|#readme|\/issues)?/g;
const CANONICAL_PUBLIC_NPM_PACKAGE = /@patodo\/localapp\b/gi;

export function isPublicSourcePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (
    normalized.startsWith("/")
    || normalized.includes("\0")
    || normalized.split("/").includes("..")
    || DENIED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || basename === ".env"
    || (basename.startsWith(".env.") && basename !== ".env.example")
  ) {
    return false;
  }
  if (!normalized.includes("/")) return ALLOWED_ROOT_FILES.has(normalized);
  return ALLOWED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
}

export function scanPublicSource(directory) {
  const violations = [];
  for (const relativePath of walk(directory)) {
    const absolutePath = path.join(directory, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile()) {
      violations.push({ path: relativePath, rule: "NON_REGULAR_FILE" });
      continue;
    }
    if (!isPublicSourcePath(relativePath) && relativePath !== "public-source-manifest.json") {
      violations.push({ path: relativePath, rule: "PATH_NOT_ALLOWED" });
    }
    if (stat.size > MAX_SOURCE_FILE_BYTES) {
      violations.push({ path: relativePath, rule: "FILE_TOO_LARGE" });
    }
    if (DENIED_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      violations.push({ path: relativePath, rule: "RELEASE_BINARY_EXTENSION" });
    }

    const bytes = fs.readFileSync(absolutePath);
    if (hasExecutableMagic(bytes)) {
      violations.push({ path: relativePath, rule: "RELEASE_BINARY_MAGIC" });
    }
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    scanText(relativePath, text, violations);
  }
  return applyReviewedBaseline(directory, violations);
}

export function exportPublicSource({
  commit,
  outputDirectory,
  verify = false,
}) {
  const commitSha = git(["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  assertSafeOutputDirectory(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });

  const trackedFiles = gitBuffer(["ls-tree", "-r", "--name-only", "-z", commitSha])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const selectedFiles = trackedFiles.filter(isPublicSourcePath).sort();
  if (selectedFiles.length === 0) throw new Error("public source allowlist selected no files");

  const archive = gitBuffer(["archive", "--format=tar", commitSha, "--", ...selectedFiles]);
  const extraction = spawnSync("tar", ["-xf", "-", "-C", outputDirectory], {
    input: archive,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (extraction.status !== 0) {
    throw new Error(`failed to extract public source archive: ${extraction.stderr}`);
  }

  const violations = scanPublicSource(outputDirectory);
  if (violations.length > 0) {
    throw new Error(formatViolations(violations));
  }

  const manifest = createSourceManifest(outputDirectory, commitSha);
  fs.writeFileSync(
    path.join(outputDirectory, "public-source-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (verify) verifySnapshot(outputDirectory);
  return manifest;
}

function createSourceManifest(directory, commitSha) {
  const files = walk(directory)
    .filter((relativePath) => relativePath !== "public-source-manifest.json")
    .map((relativePath) => {
      const bytes = fs.readFileSync(path.join(directory, relativePath));
      return {
        path: relativePath,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
  const digestInput = files
    .map((file) => `${file.sha256} ${file.size} ${file.path}\n`)
    .join("");
  return {
    schemaVersion: 1,
    sourceCommit: commitSha,
    fileCount: files.length,
    contentSha256: createHash("sha256").update(digestInput).digest("hex"),
    files,
  };
}

function verifySnapshot(directory) {
  const env = snapshotVerificationEnvironment(directory, process.env);
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  for (const [command, args] of snapshotVerificationCommands()) {
    const result = spawnSync(command, args, { cwd: directory, env, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`snapshot verification failed: ${command} ${args.join(" ")}`);
  }
}

export function snapshotVerificationCommands() {
  return [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["test:public-source"]],
    ["pnpm", ["test:release-manifest"]],
    ["pnpm", ["test:release-workflow"]],
    ["pnpm", ["-C", "packages/server-core", "build"]],
    ["pnpm", ["-C", "packages/server-core", "test"]],
    ["node", ["scripts/build-plugin-packages.mjs"]],
    ["pnpm", ["-C", "packages/web", "build"]],
    ["pnpm", ["-C", "packages/web", "test"]],
    // Exercise release packaging before Server/dist can hide missing source aliases.
    ["pnpm", ["package:localapp"]],
    ["pnpm", ["-C", "packages/dsh-model-settings", "build"]],
    ["pnpm", ["-C", "packages/dsh-multiuser", "build"]],
    ["pnpm", ["-C", "packages/server", "build"]],
    ["pnpm", ["-C", "packages/server", "test"]],
    ["pnpm", ["-C", "packages/crdt", "build"]],
    ["pnpm", ["-C", "packages/crdt", "test"]],
    ["pnpm", ["-C", "packages/localapp", "build"]],
    ["pnpm", ["-C", "packages/localapp", "test"]],
    ["pnpm", ["-C", "packages/localapp", "test:native"]],
    ["pnpm", ["-C", "packages/localapp", "pack", "--pack-destination", "../../tmp/localapp-package"]],
    ["pnpm", ["-C", "init-repo", "test"]],
    ["openspec", ["validate", "--all", "--strict"]],
  ];
}

export function snapshotVerificationEnvironment(directory, baseEnvironment = process.env) {
  const temporaryDirectory = path.join(directory, ".tmp");
  return {
    ...baseEnvironment,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
  };
}

function scanText(relativePath, text, violations) {
  const rules = [
    ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["INTERNAL_DOMAIN", /\b(?:git\.df2cloud\.com|df2cloud\.internal)\b/i],
    ["LOCAL_ABSOLUTE_PATH", /(?:\/Users\/[A-Za-z0-9._-]+\/|\/Volumes\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/],
  ];
  for (const [rule, pattern] of rules) {
    if (pattern.test(text)) violations.push({ path: relativePath, rule });
  }
  const identityScanText = text
    .replace(CANONICAL_PUBLIC_REPOSITORY_URL, "https://github.com/public-owner/public-repository")
    .replace(CANONICAL_PUBLIC_NPM_PACKAGE, "@public-owner/public-package");
  if (PRIVATE_IDENTITY_MARKERS.some((marker) => identityScanText.toLowerCase().includes(marker))) {
    violations.push({ path: relativePath, rule: "PRIVATE_TEST_IDENTITY" });
  }

  const credentialAssignments = [
    ...text.matchAll(/(?:^|[\s{,])["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*[:=]\s*["']([^"'\r\n]{16,})["']/gm),
    ...text.matchAll(/^\s*(?:export\s+)?["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*[:=]\s*["']?([A-Za-z0-9_./+=:@-]{16,})["']?(?:\s+#.*)?$/gm),
  ];
  for (const match of credentialAssignments) {
    if (!isCredentialKey(match[1])) continue;
    const value = match[2].toLowerCase();
    if (!SAFE_CREDENTIAL_MARKERS.some((marker) => value.includes(marker))) {
      violations.push({ path: relativePath, rule: "POSSIBLE_CREDENTIAL" });
      break;
    }
  }
}

function applyReviewedBaseline(directory, violations) {
  const baselinePath = path.join(directory, SCAN_BASELINE_PATH);
  if (!fs.existsSync(baselinePath)) return violations;
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid public source scan baseline: ${error.message}`);
  }
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.exceptions)) {
    throw new Error("invalid public source scan baseline schema");
  }
  const reviewed = new Set();
  for (const exception of baseline.exceptions) {
    if (!exception || typeof exception.path !== "string" || typeof exception.rule !== "string"
      || typeof exception.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(exception.sha256)
      || !isPublicSourcePath(exception.path)) {
      throw new Error("invalid public source scan baseline exception");
    }
    const key = `${exception.rule}\0${exception.path}`;
    if (reviewed.has(key)) throw new Error("duplicate public source scan baseline exception");
    const filePath = path.join(directory, exception.path);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) continue;
    const digest = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (digest === exception.sha256) reviewed.add(key);
  }
  return violations.filter((violation) => !reviewed.has(`${violation.rule}\0${violation.path}`));
}

function isCredentialKey(key) {
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.some((word) => ["apikey", "password", "secret", "token"].includes(word))
    || words.some((word, index) => word === "api" && words[index + 1] === "key");
}

function hasExecutableMagic(bytes) {
  if (bytes.length < 4) return false;
  const firstFour = bytes.subarray(0, 4).toString("hex");
  const prefix = bytes.subarray(0, 8).toString("hex");
  return bytes.subarray(0, 4).toString("ascii") === "\x7fELF"
    || bytes.subarray(0, 2).toString("ascii") === "MZ"
    || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(firstFour)
    || prefix.startsWith("1f8b")
    || ["504b0304", "504b0506", "504b0708", "edabeedb", "28b52ffd", "4d534346"].includes(firstFour)
    || prefix.startsWith("fd377a585a00")
    || prefix.startsWith("425a68")
    || prefix.startsWith("526172211a07")
    || prefix.startsWith("377abcaf271c")
    || prefix === "213c617263683e0a"
    || bytes.subarray(32_769, 32_774).toString("ascii") === "CD001";
}

function walk(directory, prefix = "") {
  const entries = fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(directory, relativePath));
    else files.push(relativePath);
  }
  return files;
}

function assertSafeOutputDirectory(directory) {
  const resolved = path.resolve(directory);
  if (
    resolved === repoRoot
    || repoRoot.startsWith(`${resolved}${path.sep}`)
    || resolved.startsWith(`${repoRoot}${path.sep}`)
  ) {
    throw new Error("output directory must be isolated from the repository");
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
    throw new Error("output directory must be empty");
  }
}

function git(args) {
  return gitBuffer(args).toString("utf8");
}

function gitBuffer(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout;
}

function formatViolations(violations) {
  return [
    "public source gate failed:",
    ...violations.map((violation) => `- ${violation.rule}: ${violation.path}`),
  ].join("\n");
}

function parseArguments(argv) {
  const values = { verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verify") {
      values.verify = true;
      continue;
    }
    if (!argument?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument: ${argument ?? ""}`);
    }
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!values.commit || !values.output) throw new Error("--commit and --output are required");
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const manifest = exportPublicSource({
    commit: args.commit,
    outputDirectory: path.resolve(args.output),
    verify: args.verify,
  });
  console.log(JSON.stringify({
    success: true,
    sourceCommit: manifest.sourceCommit,
    fileCount: manifest.fileCount,
    contentSha256: manifest.contentSha256,
  }));
}
