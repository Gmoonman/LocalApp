/**
 * 解析 Referer 头并返回 host 与 pathname。
 *
 * 返回 null 表示 Referer 缺失或无法解析为 URL。
 */
export function parseReferer(referer: string | null | undefined): { host: string; pathname: string } | null {
  if (!referer || typeof referer !== "string") return null;
  try {
    const url = new URL(referer);
    return { host: url.host, pathname: url.pathname };
  } catch {
    return null;
  }
}

/**
 * 校验 Referer 是否与请求的 app 一致。
 *
 * 通过条件：
 * 1. Referer 可解析为 URL
 * 2. Referer host === 请求 host（同源，防跨域冒用）
 * 3. Referer pathname 以 `/{owner}/{app}/` 开头（同 app，防跨 app 冒用）
 *
 * 失败返回错误信息；成功返回 null。
 */
export function validateReferer(
  referer: string | null | undefined,
  expectedHost: string,
  expectedOwner: string,
  expectedApp: string,
): string | null {
  const parsed = parseReferer(referer);
  if (!parsed) {
    return "Referer header is required";
  }
  if (parsed.host !== expectedHost) {
    return "Referer must originate from the same host";
  }
  const expectedPrefix = `/${expectedOwner}/${expectedApp}/`;
  if (!parsed.pathname.startsWith(expectedPrefix)) {
    return "Referer must originate from the same app";
  }
  return null;
}
