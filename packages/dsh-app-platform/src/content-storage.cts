import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
export interface ContentStorageConfig {
  dataDir: string; minioEndpoint: string; minioAccessKey: string; minioSecretKey: string; minioBucket: string;
}
import { contentTypeForFilename } from "./content-capabilities.cjs";

let s3Client: S3Client | null = null;
let bucketName: string = "";
let useLocalStorage: boolean = false;
let dataDir: string = "";

export type StoredObjectInfo = {
  key: string;
  size: number;
  contentType?: string;
};

export async function initContentStorage<T extends ContentStorageConfig>(config: T): Promise<void> {
  dataDir = config.dataDir;

  try {
    const [endpoint, port] = config.minioEndpoint.includes(":")
      ? (() => {
          const idx = config.minioEndpoint.lastIndexOf(":");
          return [config.minioEndpoint.slice(0, idx), config.minioEndpoint.slice(idx + 1)];
        })()
      : [config.minioEndpoint, undefined];

    s3Client = new S3Client({
      endpoint: port ? `http://${endpoint}:${port}` : `http://${endpoint}`,
      region: "us-east-1",
      credentials: {
        accessKeyId: config.minioAccessKey,
        secretAccessKey: config.minioSecretKey,
      },
      forcePathStyle: true,
    });

    bucketName = config.minioBucket;
    await ensureBucket();
    useLocalStorage = false;
    console.log(`Content storage: S3 (${config.minioEndpoint}/${bucketName})`);
  } catch (err) {
    useLocalStorage = true;
    s3Client = null;
    console.log(`Content storage: local filesystem (${dataDir}) — MinIO unavailable`);
  }
}

/** @deprecated Use initContentStorage instead */
export { initContentStorage as initS3Client };

async function ensureBucket(): Promise<void> {
  if (!s3Client) throw new Error("S3 client not initialized");
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
  }
}

function localObjectPath(root: string, key: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, key);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Invalid content object key");
  }
  return resolved;
}

function canonicalLocalPath(key: string): string {
  return localObjectPath(path.join(dataDir, ".content"), key);
}

function legacyLocalPath(key: string): string {
  return localObjectPath(dataDir, key);
}

function putLocalObject(key: string, body: Buffer, _contentType: string): void {
  const filePath = canonicalLocalPath(key);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, body);
}

function getLocalObject(key: string): { body: Buffer; contentType: string } | null {
  const canonicalPath = canonicalLocalPath(key);
  const filePath = fs.existsSync(canonicalPath) ? canonicalPath : legacyLocalPath(key);
  if (!fs.existsSync(filePath)) return null;
  const contentType = contentTypeForFilename(key) ?? "application/octet-stream";
  return { body: fs.readFileSync(filePath), contentType };
}

function walkFiles(root: string, keyPrefix: string): StoredObjectInfo[] {
  if (!fs.existsSync(root)) return [];
  const result: StoredObjectInfo[] = [];
  const visit = (directory: string, relative: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath, entryRelative);
      else if (entry.isFile()) {
        const key = `${keyPrefix}${entryRelative}`;
        result.push({
          key,
          size: fs.statSync(entryPath).size,
          contentType: contentTypeForFilename(key) ?? "application/octet-stream",
        });
      }
    }
  };
  visit(root, "");
  return result;
}

function listLocalAppObjects(owner: string, appName: string): StoredObjectInfo[] {
  const contentPrefix = `${owner}/${appName}/`;
  const issuePrefix = `issues/${owner}/${appName}/`;
  const objects = new Map<string, StoredObjectInfo>();
  const add = (object: StoredObjectInfo) => objects.set(object.key, object);

  for (const object of walkFiles(canonicalLocalPath(contentPrefix), contentPrefix)) add(object);
  for (const object of walkFiles(canonicalLocalPath(issuePrefix), issuePrefix)) add(object);

  const legacyContentDir = legacyLocalPath(`${owner}/${appName}`);
  if (fs.existsSync(legacyContentDir)) {
    for (const entry of fs.readdirSync(legacyContentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{20}\.[a-z0-9]+$/i.test(entry.name)) continue;
      const key = `${contentPrefix}${entry.name}`;
      if (!objects.has(key)) add({
        key,
        size: fs.statSync(path.join(legacyContentDir, entry.name)).size,
        contentType: contentTypeForFilename(key) ?? "application/octet-stream",
      });
    }
  }

  const legacyIssueDir = legacyLocalPath(`issues/${owner}/${appName}`);
  if (fs.existsSync(legacyIssueDir)) {
    for (const entry of fs.readdirSync(legacyIssueDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const contentPath = path.join(legacyIssueDir, entry.name, "content");
      if (!fs.existsSync(contentPath) || !fs.statSync(contentPath).isFile()) continue;
      const key = `${issuePrefix}${entry.name}/content`;
      if (!objects.has(key)) add({ key, size: fs.statSync(contentPath).size, contentType: "application/octet-stream" });
    }
  }

  return [...objects.values()].sort((left, right) => left.key.localeCompare(right.key));
}

async function listS3Prefix(prefix: string): Promise<StoredObjectInfo[]> {
  if (!s3Client) throw new Error("S3 client not initialized");
  const result: StoredObjectInfo[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of response.Contents ?? []) {
      if (!object.Key || object.Size === undefined) continue;
      result.push({ key: object.Key, size: object.Size });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return result;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (useLocalStorage) {
    putLocalObject(key, body, contentType);
    return;
  }
  if (!s3Client) throw new Error("S3 client not initialized");
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObject(key: string): Promise<{ body: Buffer; contentType?: string } | null> {
  if (useLocalStorage) {
    return getLocalObject(key);
  }
  if (!s3Client) throw new Error("S3 client not initialized");
  try {
    const resp = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
    );
    const bytes = await resp.Body?.transformToByteArray();
    if (!bytes) return null;
    return {
      body: Buffer.from(bytes),
      contentType: resp.ContentType,
    };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

export async function openObject(key: string): Promise<{ body: Readable; contentType?: string } | null> {
  if (useLocalStorage) {
    const canonicalPath = canonicalLocalPath(key);
    const filePath = fs.existsSync(canonicalPath) ? canonicalPath : legacyLocalPath(key);
    if (!fs.existsSync(filePath)) return null;
    return { body: fs.createReadStream(filePath), contentType: contentTypeForFilename(key) ?? "application/octet-stream" };
  }
  if (!s3Client) throw new Error("S3 client not initialized");
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    if (!response.Body) return null;
    return { body: response.Body as Readable, contentType: response.ContentType };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

export async function putObjectFromFile(key: string, filePath: string, contentType: string): Promise<void> {
  if (useLocalStorage) {
    const targetPath = canonicalLocalPath(key);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(filePath, targetPath);
    return;
  }
  if (!s3Client) throw new Error("S3 client not initialized");
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: fs.statSync(filePath).size,
    ContentType: contentType,
  }));
}

export async function deleteObject(key: string): Promise<void> {
  if (useLocalStorage) {
    fs.rmSync(canonicalLocalPath(key), { force: true });
    fs.rmSync(legacyLocalPath(key), { force: true });
    return;
  }
  if (!s3Client) throw new Error("S3 client not initialized");
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

export async function listAppObjects(owner: string, appName: string): Promise<StoredObjectInfo[]> {
  if (useLocalStorage) return listLocalAppObjects(owner, appName);
  const objects = await Promise.all([
    listS3Prefix(`${owner}/${appName}/`),
    listS3Prefix(`issues/${owner}/${appName}/`),
  ]);
  const deduplicated = new Map(objects.flat().map((object) => [object.key, object]));
  return [...deduplicated.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export async function deleteAppObjects(owner: string, appName: string): Promise<void> {
  const objects = await listAppObjects(owner, appName);
  for (const object of objects) await deleteObject(object.key);
  if (useLocalStorage) {
    fs.rmSync(canonicalLocalPath(`${owner}/${appName}`), { recursive: true, force: true });
    fs.rmSync(canonicalLocalPath(`issues/${owner}/${appName}`), { recursive: true, force: true });
    fs.rmSync(legacyLocalPath(`issues/${owner}/${appName}`), { recursive: true, force: true });
  }
}
