import { PLATFORM_CAPABILITIES } from "./platform-capabilities.cjs";

export type ContentValidationErrorCode =
  | "CONTENT_TYPE_UNSUPPORTED"
  | "CONTENT_MIME_MISMATCH"
  | "CONTENT_SIGNATURE_INVALID"
  | "CONTENT_TOO_LARGE";

export type ContentUploadValidation =
  | {
      ok: true;
      extension: string;
      mimeType: string;
      inlinePreview: boolean;
    }
  | {
      ok: false;
      code: ContentValidationErrorCode;
      status: 400 | 413;
      message: string;
    };

export interface ContentReadResponse {
  status: 200 | 206 | 416;
  start: number | null;
  end: number | null;
  headers: Record<string, string>;
}

export function validateContentUpload(input: {
  filename: string;
  declaredMimeType: string;
  bytes: Uint8Array;
}): ContentUploadValidation {
  const extension = extensionOf(input.filename);
  const capability = PLATFORM_CAPABILITIES.content.types.find((type) => type.extension === extension);
  if (!capability) {
    return invalid("CONTENT_TYPE_UNSUPPORTED", 400, "Unsupported file type");
  }
  if (normalizeMimeType(input.declaredMimeType) !== capability.mimeType) {
    return invalid(
      "CONTENT_MIME_MISMATCH",
      400,
      `Declared MIME type must be ${capability.mimeType}`,
    );
  }
  if (input.bytes.byteLength > PLATFORM_CAPABILITIES.content.upload.maxBytes) {
    return invalid(
      "CONTENT_TOO_LARGE",
      413,
      `File exceeds ${formatMiB(PLATFORM_CAPABILITIES.content.upload.maxBytes)} limit`,
    );
  }
  if (!hasValidSignature(extension, input.bytes)) {
    return invalid("CONTENT_SIGNATURE_INVALID", 400, "File content does not match its type");
  }
  return {
    ok: true,
    extension,
    mimeType: capability.mimeType,
    inlinePreview: capability.inlinePreview,
  };
}

export function contentTypeForFilename(filename: string): string | null {
  const extension = extensionOf(filename);
  return PLATFORM_CAPABILITIES.content.types.find((type) => type.extension === extension)?.mimeType ?? null;
}

export function buildContentReadResponse(input: {
  filename: string;
  size: number;
  rangeHeader?: string;
}): ContentReadResponse {
  const capability = PLATFORM_CAPABILITIES.content.types.find(
    (type) => type.extension === extensionOf(input.filename),
  );
  const contentType = capability?.mimeType ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(input.filename, capability?.inlinePreview === true),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
  if (contentType === "image/svg+xml") {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
  }

  if (!input.rangeHeader) {
    headers["Content-Length"] = String(input.size);
    return {
      status: 200,
      start: input.size > 0 ? 0 : null,
      end: input.size > 0 ? input.size - 1 : null,
      headers,
    };
  }

  const range = parseByteRange(input.rangeHeader, input.size);
  if (!range) {
    headers["Content-Range"] = `bytes */${input.size}`;
    headers["Content-Length"] = "0";
    return { status: 416, start: null, end: null, headers };
  }

  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${input.size}`;
  headers["Content-Length"] = String(range.end - range.start + 1);
  return { status: 206, start: range.start, end: range.end, headers };
}

function invalid(
  code: ContentValidationErrorCode,
  status: 400 | 413,
  message: string,
): ContentUploadValidation {
  return { ok: false, code, status, message };
}

function extensionOf(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function hasValidSignature(extension: string, input: Uint8Array): boolean {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  switch (extension) {
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "gif":
      return bytes.subarray(0, 6).toString("ascii") === "GIF87a"
        || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
    case "webp":
      return bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    case "svg": {
      const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();
      return /^<svg(?:\s|>)/i.test(prefix) || /^<\?xml[\s\S]*?<svg(?:\s|>)/i.test(prefix);
    }
    default:
      return false;
  }
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  if (size <= 0 || !header.startsWith("bytes=") || header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return null;
  if (start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function contentDisposition(filename: string, inline: boolean): string {
  const basename = filename.split(/[\\/]/).pop() || "download";
  const fallback = basename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(basename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function formatMiB(bytes: number): string {
  return `${bytes / (1024 * 1024)}MB`;
}
