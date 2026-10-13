import type {} from "@fastify/multipart";
import type { FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import {
  buildContentReadResponse,
  validateContentUpload,
} from "./content-capabilities.cjs";
import { putObject, getObject } from "./content-storage.cjs";
import yauzl from "yauzl";
import { recordFileUploader } from "./content-bundles.cjs";
import { withAppDataObjectWrite } from "./app-data-maintenance.cjs";

export async function handleContentUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  pageName: string,
  pageDir?: string,
  storage = { putObject, getObject },
  responseContentBase?: string,
  uploader?: string,
): Promise<void> {
  const data = await req.file();
  if (!data) {
    reply.status(400).send({ success: false, error: "No file provided" });
    return;
  }

  const buffer = await data.toBuffer();
  const validation = validateContentUpload({
    filename: data.filename,
    declaredMimeType: data.mimetype,
    bytes: buffer,
  });
  if (!validation.ok) {
    reply.status(validation.status).send({
      success: false,
      error: validation.message,
      code: validation.code,
    });
    return;
  }

  if (validation.extension === "xlsx" && !await validWorkbook(buffer)) {
    reply.status(400).send({success:false,code:"CONTENT_SIGNATURE_INVALID",error:"File is not a valid XLSX workbook"});
    return;
  }
  const contentKey = `${randomBytes(10).toString("hex")}.${validation.extension}`;
  const s3Key = `${userId}/${pageName}/${contentKey}`;

  if (pageDir) await withAppDataObjectWrite(pageDir, async () => {
    await storage.putObject(s3Key, buffer, validation.mimeType);
    if (uploader) recordFileUploader(pageDir, contentKey, uploader);
  });
  else await storage.putObject(s3Key, buffer, validation.mimeType);

  reply.status(201).send({
    success: true,
    data: {
      key: contentKey,
      url: responseContentBase ? `${responseContentBase}${contentKey}` : `/serve/${userId}/${pageName}/api/content/${contentKey}`,
    },
  });
}

export async function handleContentRead(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  pageName: string,
  key: string,
  storage = { putObject, getObject },
): Promise<void> {
  const s3Key = `${userId}/${pageName}/${key}`;
  const result = await storage.getObject(s3Key);
  if (!result) {
    reply.status(404).send({ success: false, error: "File not found" });
    return;
  }

  const response = buildContentReadResponse({
    filename: key,
    size: result.body.length,
    rangeHeader: typeof req.headers.range === "string" ? req.headers.range : undefined,
  });
  for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
  if (response.status === 416) {
    reply.status(416).send();
    return;
  }
  const body = response.start === null || response.end === null
    ? result.body
    : result.body.subarray(response.start, response.end + 1);
  reply.status(response.status).send(body);
}

async function validWorkbook(buffer: Buffer): Promise<boolean> {
  return new Promise(resolve => yauzl.fromBuffer(buffer, { lazyEntries:true }, (error, zip) => {
    if (error || !zip) return resolve(false);
    const names = new Set<string>(); let count = 0; let expanded = 0;
    zip.on("error", () => { zip.close(); resolve(false); });
    zip.on("entry", entry => {
      count++; expanded += entry.uncompressedSize;
      if (count > 10000 || expanded > 100 * 1024 ** 2 || names.has(entry.fileName) || entry.generalPurposeBitFlag & 1) { zip.close(); resolve(false); return; }
      names.add(entry.fileName); zip.readEntry();
    });
    zip.on("end", () => resolve(names.has("[Content_Types].xml") && names.has("xl/workbook.xml")));
    zip.readEntry();
  }));
}
