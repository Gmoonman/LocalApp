import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { isPublicSourcePath, scanPublicSource, snapshotVerificationCommands, snapshotVerificationEnvironment } from "./export-public-source.mjs";

test("top-level allowlist includes sanitized history and excludes internal runtime data and release binaries", () => {
  assert.equal(isPublicSourcePath("AGENTS.md"), true);
  assert.equal(isPublicSourcePath("benchmarks/agent-first-run/README.md"), true);
  assert.equal(isPublicSourcePath("docs/local-runtime.md"), true);
  assert.equal(isPublicSourcePath("docs/npm-release.md"), true);
  assert.equal(isPublicSourcePath("docs/plan.md"), true);
  assert.equal(isPublicSourcePath("packages/crdt/src/index.ts"), true);
  assert.equal(isPublicSourcePath("packages/server/src/index.ts"), true);
  assert.equal(isPublicSourcePath("init-repo/.claude/skills/localapp/SKILL.md"), true);
  assert.equal(isPublicSourcePath("openspec/specs/cli-tool/spec.md"), true);
  assert.equal(isPublicSourcePath(".agents/skills/opsx-apply/SKILL.md"), false);
  assert.equal(isPublicSourcePath("openspec/changes/archive/old/design.md"), true);
  assert.equal(isPublicSourcePath("openspec/changes/in-progress/design.md"), false);
  assert.equal(isPublicSourcePath("packages/server/static/cli/1.0.0/localapp"), false);
  assert.equal(isPublicSourcePath("packages/localapp/runtime/native/win32-x64/localapp-native.exe"), true);
  assert.equal(isPublicSourcePath("packages/server/.env"), false);
  assert.equal(isPublicSourcePath("deploy/production/.env.local"), false);
});

test("snapshot verification uses the unified package and no replaced Rust or Desktop product", () => {
  assert.deepEqual(snapshotVerificationCommands().map(([command, args]) => `${command} ${args.join(" ")}`), [
    "pnpm install --frozen-lockfile",
    "pnpm test:public-source",
    "pnpm test:release-manifest",
    "pnpm test:release-workflow",
    "pnpm -C packages/server-core build",
    "pnpm -C packages/server-core test",
    "pnpm -C packages/web build",
    "pnpm -C packages/web test",
    "pnpm package:localapp",
    "pnpm -C packages/dsh-multiuser build",
    "pnpm -C packages/server build",
    "pnpm -C packages/server test",
    "pnpm -C packages/crdt build",
    "pnpm -C packages/crdt test",
    "pnpm -C packages/localapp build",
    "pnpm -C packages/localapp test",
    "pnpm -C packages/localapp test:native",
    "pnpm -C packages/localapp pack --pack-destination ../../tmp/localapp-package",
    "pnpm -C init-repo test",
    "openspec validate --all --strict",
  ]);
});

test("snapshot verification keeps temporary files inside the isolated snapshot", () => {
  const root = path.join(path.sep, "isolated", "source");
  const environment = snapshotVerificationEnvironment(root, { PATH: "tools" });
  assert.equal(environment.PATH, "tools");
  assert.equal(environment.TMPDIR, path.join(root, ".tmp"));
  assert.equal(environment.TMP, environment.TMPDIR);
  assert.equal(environment.TEMP, environment.TMPDIR);
});

test("source gate rejects unquoted environment-style credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-env-"));
  try {
    fs.mkdirSync(path.join(directory, "packages/server/src"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "packages/server/src/fixture.env.example"),
      [
        `API_KEY=${"actual-production-" + "api-key-value"}`,
        `PASSWORD=${"actual-production-" + "password-value"} # production database`,
        "",
      ].join("\n"),
    );

    assert.deepEqual(
      scanPublicSource(directory).map((violation) => violation.rule),
      ["POSSIBLE_CREDENTIAL"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate rejects JSON and YAML credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-structured-"));
  try {
    fs.mkdirSync(path.join(directory, "packages/server/src"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "packages/server/src/credentials.json"),
      `{"clientSecretBackup":"${"actual-production-" + "json-client-secret"}"}\n`,
    );
    fs.writeFileSync(
      path.join(directory, "packages/server/src/credentials.yaml"),
      `database_password_backup: "${"actual-production-" + "yaml-password"}"\n`,
    );
    fs.writeFileSync(
      path.join(directory, "packages/server/src/token.json"),
      `{"serviceTokenValue":"${"actual-production-" + "service-token"}"}\n`,
    );
    fs.writeFileSync(
      path.join(directory, "packages/server/src/api-key.yaml"),
      `backup_api_key_value: "${"actual-production-" + "backup-api-key"}"\n`,
    );

    assert.deepEqual(
      scanPublicSource(directory).map((violation) => violation.rule),
      [
        "POSSIBLE_CREDENTIAL",
        "POSSIBLE_CREDENTIAL",
        "POSSIBLE_CREDENTIAL",
        "POSSIBLE_CREDENTIAL",
      ],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate reports paths and rule names without printing credential values", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-gate-"));
  try {
    fs.mkdirSync(path.join(directory, "packages/server/src"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "packages/server/src/bad.ts"),
      [
        "const apiKey = \"actual-production-" + "credential-value\";",
        `const path = "${["", "Users", "private", "work"].join("/")}";`,
        "",
      ].join("\n"),
    );

    const violations = scanPublicSource(directory);

    assert.deepEqual(
      violations.map((violation) => violation.rule).sort(),
      ["LOCAL_ABSOLUTE_PATH", "POSSIBLE_CREDENTIAL"],
    );
    assert.ok(violations.every((violation) => !JSON.stringify(violation).includes("actual-production")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate rejects private test identities and internal domains", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-identity-"));
  try {
    fs.mkdirSync(path.join(directory, "packages/server/src"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "packages/server/src/fixture.ts"),
      [
        `const owner = "${"pato" + "do"}";`,
        `const origin = "https://${["git", "df2cloud", "com"].join(".")}";`,
        "",
      ].join("\n"),
    );

    assert.deepEqual(
      scanPublicSource(directory).map((violation) => violation.rule).sort(),
      ["INTERNAL_DOMAIN", "PRIVATE_TEST_IDENTITY"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate permits canonical public repository and npm identities but not the owner identity elsewhere", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-canonical-repo-"));
  try {
    fs.mkdirSync(path.join(directory, "packages/localapp"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "packages/localapp/package.json"),
      `${JSON.stringify({ name: "@patodo/localapp", repository: "https://github.com/Patodo/LocalApp.git" })}\n`,
    );
    assert.deepEqual(scanPublicSource(directory), []);
    fs.writeFileSync(path.join(directory, "packages/localapp/owner.txt"), "owner=patodo\n");
    assert.deepEqual(scanPublicSource(directory), [
      { path: "packages/localapp/owner.txt", rule: "PRIVATE_TEST_IDENTITY" },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate suppresses only reviewed violations with an exact file digest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-baseline-"));
  try {
    const relativePath = "packages/server/src/example.ts";
    const absolutePath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const reviewed = 'const apiKey = "actual-production-credential-value";\n';
    fs.writeFileSync(absolutePath, reviewed);
    fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(directory, "scripts/public-source-scan-baseline.json"), `${JSON.stringify({
      schemaVersion: 1,
      exceptions: [{
        path: relativePath,
        rule: "POSSIBLE_CREDENTIAL",
        sha256: createHash("sha256").update(reviewed).digest("hex"),
      }],
    })}\n`);

    assert.deepEqual(scanPublicSource(directory), []);
    fs.appendFileSync(absolutePath, "// changed after review\n");
    assert.deepEqual(scanPublicSource(directory), [
      { path: relativePath, rule: "POSSIBLE_CREDENTIAL" },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate rejects executable magic even when the extension looks textual", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-binary-"));
  try {
    fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(directory, "scripts/payload.txt"), Buffer.from("7f454c460000", "hex"));

    assert.deepEqual(scanPublicSource(directory), [
      { path: "scripts/payload.txt", rule: "RELEASE_BINARY_MAGIC" },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source gate rejects archive and installer extensions and magic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "localapp-public-archive-"));
  try {
    fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(directory, "scripts/release.xz"), "not-even-compressed");
    fs.writeFileSync(path.join(directory, "scripts/release.rpm"), "not-even-packaged");
    fs.writeFileSync(
      path.join(directory, "scripts/disguised-xz.txt"),
      Buffer.from("fd377a585a0000", "hex"),
    );
    fs.writeFileSync(
      path.join(directory, "scripts/disguised-deb.txt"),
      Buffer.from("213c617263683e0a", "hex"),
    );

    assert.deepEqual(
      scanPublicSource(directory)
        .map((violation) => violation.rule)
        .sort(),
      [
        "RELEASE_BINARY_EXTENSION",
        "RELEASE_BINARY_EXTENSION",
        "RELEASE_BINARY_MAGIC",
        "RELEASE_BINARY_MAGIC",
      ],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("default Server tests exclude generated-app acceptance while preserving its explicit command", () => {
  const serverConfig = fs.readFileSync(new URL("../packages/server/vitest.config.ts", import.meta.url), "utf8");
  const rootManifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(serverConfig, /tests\/e2e-unified\/real-apps\.spec\.ts/);
  assert.match(rootManifest.scripts["test:real-apps"], /real-apps\.spec\.ts/);
});

test("every reviewed baseline exception still matches the file it pins", () => {
  // Break caught: editing a baselined file leaves its reviewed digest stale, and
  // the export gate only reports that after a full CI round trip.
  const baseline = JSON.parse(fs.readFileSync(new URL("./public-source-scan-baseline.json", import.meta.url), "utf8"));
  const stale = [];
  for (const exception of baseline.exceptions) {
    const bytes = fs.readFileSync(new URL(`../${exception.path}`, import.meta.url));
    // The export hashes committed content, which is LF on every platform, while a
    // Windows checkout materializes the same file with CRLF.
    const digest = createHash("sha256").update(bytes.toString("binary").replace(/\r\n/g, "\n"), "binary").digest("hex");
    if (digest !== exception.sha256) stale.push(`${exception.rule} ${exception.path}`);
  }
  assert.deepEqual(stale, [], `refresh the recorded sha256 for: ${stale.join(", ")}`);
});
