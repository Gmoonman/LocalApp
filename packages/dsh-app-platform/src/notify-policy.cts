import type { PageMeta } from "./page-storage.cjs";

/**
 * 判断页面是否应当暴露 notify 端点。
 *
 * 仅当 manifest.notify.enabled === true 时端点存在；其余情况（字段缺失、
 * enabled=false、配置非法被规整化为 undefined）均视为端点不存在，返回 404。
 */
export function shouldRegisterNotify(meta: PageMeta | null): boolean {
  return meta?.notify?.enabled === true;
}
