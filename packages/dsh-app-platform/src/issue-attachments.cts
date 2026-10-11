export const MAX_ISSUE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function sanitizeIssueAttachmentFileName(value: string): string {
  const baseName = value.replace(/\\/g, "/").split("/").pop() ?? "";
  const sanitized = baseName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 180);
  return sanitized || "attachment";
}

export function normalizeIssueAttachmentMimeType(value: string | undefined): string {
  return value?.trim().toLowerCase() || "application/octet-stream";
}

export function isInlineIssueAttachment(mimeType: string): boolean {
  return INLINE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function issueAttachmentContentDisposition(fileName: string, inline: boolean): string {
  const encodedFileName = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFileName}`;
}

export function issueAttachmentUrl(pagePath: string, attachmentId: string): string {
  return `/api/issues/attachments/${encodeURIComponent(attachmentId)}?pagePath=${encodeURIComponent(pagePath)}`;
}
