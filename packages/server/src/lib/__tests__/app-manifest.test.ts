import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageMeta } from "../../plugins/storage.js";
import { getAppLifecycleStatus, isAppOffline } from "../app-lifecycle.js";
import {
  mergeManifests,
  materializeManifest,
  readManifestState,
  removePlatformManifest,
  validatePlatformManifest,
  writePlatformManifest,
  writeSourceManifest,
} from "../app-manifest.js";

function pageMeta(): PageMeta {
  return {
    name: "demo",
    userId: "owner",
    description: "legacy description",
    currentVersion: 3,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T01:00:00.000Z",
    versions: [],
    metadata: {},
    pageAccess: { level: "authenticated" },
    shell: { navbar: true },
    db: { mode: "crud", defaultAccess: { read: "public", update: "owner" } },
  };
}

describe("app manifest state", () => {
  let pageDir: string;

  beforeEach(() => {
    const root = path.resolve(__dirname, "../../../../../tmp/app-manifest-tests");
    fs.mkdirSync(root, { recursive: true });
    pageDir = fs.mkdtempSync(path.join(root, "case-"));
  });

  afterEach(() => {
    fs.rmSync(pageDir, { recursive: true, force: true });
  });

  it("deep-merges objects, replaces arrays, and gives platform values priority", () => {
    expect(mergeManifests(
      {
        description: "source",
        db: { mode: "crud", defaultAccess: { read: "public", update: "owner" } },
        tags: ["source"],
      },
      {
        description: "platform",
        db: { defaultAccess: { read: "owner" } },
        tags: ["platform"],
      },
    )).toEqual({
      description: "platform",
      db: { mode: "crud", defaultAccess: { read: "owner", update: "owner" } },
      tags: ["platform"],
    });
  });

  it("projects a compatible source view from metadata for legacy apps", () => {
    const state = readManifestState(pageDir, pageMeta());

    expect(state.sourceKind).toBe("legacy-projection");
    expect(state.sourceManifest).toMatchObject({
      name: "demo",
      description: "legacy description",
      pageAccess: { level: "authenticated" },
      shell: { navbar: true },
      db: { mode: "crud" },
    });
    expect(state.platformManifest).toEqual({});
    expect(state.effectiveManifest).toEqual(state.sourceManifest);
  });

  it("persists source and platform manifests separately", () => {
    writeSourceManifest(pageDir, { name: "demo", description: "source" });
    writePlatformManifest(pageDir, { description: "platform", shell: { navbar: false } });

    const state = readManifestState(pageDir, pageMeta());
    expect(state.sourceKind).toBe("uploaded");
    expect(state.sourceManifest.description).toBe("source");
    expect(state.platformManifest).toEqual({ description: "platform", shell: { navbar: false } });
    expect(state.effectiveManifest).toMatchObject({
      name: "demo",
      description: "platform",
      shell: { navbar: false },
    });

    removePlatformManifest(pageDir);
    expect(readManifestState(pageDir, pageMeta()).effectiveManifest.description).toBe("source");
  });

  it("persists source defaults and platform overrides for the Agent conversation", () => {
    const meta = pageMeta();
    writeSourceManifest(pageDir, { name: "demo", shell: { agentConversation: false } });
    expect(materializeManifest(meta, readManifestState(pageDir, meta).effectiveManifest).shell?.agentConversation).toBe(false);
    writePlatformManifest(pageDir, { shell: { agentConversation: true } });
    expect(readManifestState(pageDir, meta).effectiveManifest.shell).toMatchObject({ agentConversation: true });
    expect(materializeManifest(meta, readManifestState(pageDir, meta).effectiveManifest).shell?.agentConversation).toBe(true);
    removePlatformManifest(pageDir);
    expect(readManifestState(pageDir, meta).effectiveManifest.shell).toMatchObject({ agentConversation: false });
  });

  it("rejects platform fields that depend on source artifacts", () => {
    expect(() => validatePlatformManifest({ backend: { root: "backend" } })).toThrowError(
      /backend/,
    );
    expect(() => validatePlatformManifest({ name: "renamed" })).toThrowError(/name/);
  });

  it("rejects malformed editable fields", () => {
    expect(() => validatePlatformManifest({ description: 42 })).toThrowError(/description/);
    expect(() => validatePlatformManifest({ shell: { navbar: "yes" } })).toThrowError(/shell\.navbar/);
    expect(() => validatePlatformManifest({ shell: { agentConversation: "false" } })).toThrowError(/shell\.agentConversation/);
    expect(() => validatePlatformManifest({ pageAccess: { level: "root" } })).toThrowError(/pageAccess\.level/);
    expect(() => validatePlatformManifest({ db: { mode: "document" } })).toThrowError(/db\.mode/);
    expect(() => validatePlatformManifest({ notify: { enabled: "yes" } })).toThrowError(/notify\.enabled/);
    expect(() => validatePlatformManifest({ lifecycle: { status: "paused" } })).toThrowError(/lifecycle\.status/);
  });

  it("accepts and materializes a platform lifecycle status", () => {
    expect(() => validatePlatformManifest({ lifecycle: { status: "offline" } })).not.toThrow();

    const materialized = materializeManifest(pageMeta(), {
      lifecycle: { status: "offline" },
    });

    expect(materialized.lifecycle).toEqual({ status: "offline" });
  });

  it("defaults lifecycle status to online and detects explicit offline state", () => {
    expect(getAppLifecycleStatus({})).toBe("online");
    expect(isAppOffline({})).toBe(false);
    expect(getAppLifecycleStatus({ lifecycle: { status: "offline" } })).toBe("offline");
    expect(isAppOffline({ lifecycle: { status: "offline" } })).toBe(true);
  });

  it("materializes only effective runtime fields into page metadata", () => {
    const materialized = materializeManifest(pageMeta(), {
      name: "cannot-rename",
      description: "effective",
      pageAccess: { level: "owner" },
      shell: { navbar: false },
      db: { mode: "sql", sqlAccess: "owner" },
      notify: { enabled: false },
    });

    expect(materialized).toMatchObject({
      name: "demo",
      description: "effective",
      pageAccess: { level: "owner" },
      shell: { navbar: false },
      db: { mode: "sql", sqlAccess: "owner" },
      notify: { enabled: false },
    });
  });

  it("treats CLI-serialized null optional sections as absent runtime config", () => {
    const meta = pageMeta();
    meta.lifecycle = { status: "offline" };
    const materialized = materializeManifest(meta, {
      name: "demo",
      description: "",
      pageAccess: null,
      shell: null,
      db: null,
      notify: null,
      lifecycle: null,
    });

    expect(materialized.pageAccess).toBeUndefined();
    expect(materialized.shell).toBeUndefined();
    expect(materialized.db).toBeUndefined();
    expect(materialized.notify).toBeUndefined();
    expect(materialized.lifecycle).toBeUndefined();
  });
});
