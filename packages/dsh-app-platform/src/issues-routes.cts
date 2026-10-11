import { listIssueSavedViews, createIssueSavedView, updateIssueSavedView, duplicateIssueSavedView, deleteIssueSavedView, IssueSavedViewLimitError } from "./issue-saved-views.cjs";
import { FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { getPageDir, readPageMeta } from "./page-storage.cjs";
import {
  getDbPath,
  listIssues,
  listPotentialDuplicateIssues,
  insertIssue,
  getIssueById,
  getIssueDetail,
  getIssueDetailByNumber,
  getIssueComment,
  insertIssueComment,
  updateIssueComment,
  deleteIssueComment,
  deleteIssue,
  insertIssueEvent,
  insertIssueRevision,
  listIssueRevisions,
  insertIssueAttachment,
  bindIssueAttachments,
  getIssueAttachment,
  getIssueCollaborationMetadata,
  listExpiredUnboundIssueAttachments,
  listIssueLabels,
  createIssueLabel,
  updateIssueLabel,
  deleteIssueLabel,
  listIssueMilestones,
  createIssueMilestone,
  updateIssueMilestone,
  deleteIssueMilestone,
  setIssueMilestone,
  replaceIssueLabels,
  replaceIssueAssignees,
  replaceIssueMentions,
  setIssueSubscription,
  setIssueLock,
  setIssuePin,
  setIssueCommentPin,
  setIssueCommentMinimized,
  convertIssueTaskToSubIssue,
  isIssueCommentMinimizedReason,
  addIssueSubIssue,
  removeIssueSubIssue,
  reprioritizeIssueSubIssue,
  listIssueAncestorIds,
  listIssueSubIssues,
  addIssueDependency,
  removeIssueDependency,
  parseIssueDuplicateReference,
  markIssueDuplicateWithComment,
  unmarkIssueDuplicate,
  reconcileIssueCrossReferences,
  setIssueReaction,
  isIssueReactionContent,
  isIssueLockReason,
  isIssueType,
  parseIssueSearchScopes,
  deleteIssueAttachmentMetadata,
  releaseUnboundIssueAttachment,
  restoreReleasedIssueAttachment,
  deleteBoundIssueAttachments,
  runDbTransaction,
  updateIssue,
  type IssueAttachmentRecord,
  type IssueDetail,
  type IssueListDirection,
  type IssueListOptions,
  type IssueListSort,
  type IssueType,
  type AddIssueSubIssueResult,
  type AddIssueDependencyResult,
  type InsertIssueDuplicateResult,
} from "./app-db.cjs";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type * as ContentStorage from "./content-storage.cjs";
import { checkPageAccess } from "./access-control.cjs";

import {
  isInlineIssueAttachment,
  issueAttachmentContentDisposition,
  issueAttachmentUrl,
  MAX_ISSUE_ATTACHMENT_BYTES,
  normalizeIssueAttachmentMimeType,
  sanitizeIssueAttachmentFileName,
} from "./issue-attachments.cjs";

import { withAppDataObjectWrite } from "./app-data-maintenance.cjs";
import type { NotificationStore } from "./notifications.cjs";
import { parseIssueMentions } from "./issue-mentions.cjs";

export interface SavedReplyRecord {
  id: number; userId: string; title: string; body: string; createdAt: string; updatedAt: string;
}
export interface IssueRoutesHost {
  storage: Pick<typeof ContentStorage, "deleteObject" | "getObject" | "putObject">;
  dataDir: string;
  visitor(request: FastifyRequest): string | null | undefined;
  userExists(userId: string): boolean;
  persistNotifications: NotificationStore["persistNotifications"];
  listSavedReplies(userId: string): SavedReplyRecord[];
  createSavedReply(userId: string, input: { title: string; body: string }): SavedReplyRecord;
  updateSavedReply(userId: string, id: number, input: { title: string; body: string }): SavedReplyRecord | null;
  deleteSavedReply(userId: string, id: number): boolean;
}
export async function registerIssues(app: FastifyInstance, host: IssueRoutesHost) {
  const { deleteObject, getObject, putObject } = host.storage;
  const { userExists: findUserById, persistNotifications, createSavedReply, deleteSavedReply, listSavedReplies, updateSavedReply } = host;
const ISSUE_TITLE_MAX_CHARACTERS = 256;

function issueTitleTooLong(title: string): boolean {
  return Array.from(title.trim()).length > ISSUE_TITLE_MAX_CHARACTERS;
}

async function notifyIssueMentions(input: {
  dbPath: string;
  markdown: string;
  previousMarkdown?: string;
  actorId: string;
  appOwner: string;
  appName: string;
  issue: { id: number; issue_number: number; title: string };
  commentId?: number;
}): Promise<string[]> {
  const [nextIds, previousIds] = await Promise.all([
    resolveIssueMentionUserIds(input.markdown),
    resolveIssueMentionUserIds(input.previousMarkdown ?? ""),
  ]);
  const previous = new Set(previousIds);
  const recipients = nextIds.filter((userId) => userId !== input.actorId && !previous.has(userId));
  if (recipients.length > 0) {
    await runDbTransaction(input.dbPath, async () => {
      for (const userId of recipients) await setIssueSubscription(input.dbPath, input.issue.id, userId, true);
    });
  }
  const params = new URLSearchParams({ localappIssues: "1", localappIssueId: String(input.issue.id) });
  if (input.commentId !== undefined) params.set("localappIssueCommentId", String(input.commentId));
  persistNotifications(recipients.map((userId) => ({
    id: "",
    userId,
    appOwner: input.appOwner,
    appName: input.appName,
    title: `${input.actorId} 在 Issue 中提及了你：${input.issue.title}`,
    body: `#${input.issue.issue_number}`,
    url: `/${input.appOwner}/${input.appName}/?${params.toString()}`,
    priority: "normal" as const,
    data: { type: "issue_mentioned", issueId: input.issue.id, issueNumber: input.issue.issue_number, ...(input.commentId === undefined ? {} : { commentId: input.commentId }) },
  })));
  return recipients;
}

async function resolveIssueMentionUserIds(markdown: string): Promise<string[]> {
  return (await parseIssueMentions(markdown)).filter((userId) => findUserById(userId));
}

async function notifyIssueSubscribers(input: {
  dbPath: string;
  actorId: string;
  appOwner: string;
  appName: string;
  issue: { id: number; issue_number: number; title: string };
  kind: "commented" | "status_changed";
  commentId?: number;
  status?: "open" | "closed";
  stateReason?: "completed" | "not_planned" | null;
  excludeUserIds?: readonly string[];
}): Promise<void> {
  const metadata = await getIssueCollaborationMetadata(input.dbPath, input.issue.id);
  const excluded = new Set([input.actorId, ...(input.excludeUserIds ?? [])]);
  const recipients = metadata.subscriber_ids.filter((userId) => !excluded.has(userId) && findUserById(userId));
  if (recipients.length === 0) return;
  const params = new URLSearchParams({ localappIssues: "1", localappIssueId: String(input.issue.id) });
  if (input.commentId !== undefined) params.set("localappIssueCommentId", String(input.commentId));
  const action = input.kind === "commented" ? "评论了" : input.status === "closed" ? input.stateReason === "not_planned" ? "以不计划处理关闭了" : "以已完成关闭了" : "重新打开了";
  persistNotifications(recipients.map((userId) => ({
    id: "",
    userId,
    appOwner: input.appOwner,
    appName: input.appName,
    title: `${input.actorId} ${action}你订阅的 Issue：${input.issue.title}`,
    body: `#${input.issue.issue_number}`,
    url: `/${input.appOwner}/${input.appName}/?${params.toString()}`,
    priority: "normal" as const,
    data: input.kind === "commented"
      ? { type: "issue_commented", issueId: input.issue.id, issueNumber: input.issue.issue_number, commentId: input.commentId }
      : { type: "issue_status_changed", issueId: input.issue.id, issueNumber: input.issue.issue_number, status: input.status, stateReason: input.stateReason },
  })));
}

function publicAttachment({ storage_key: _storageKey, ...attachment }: IssueAttachmentRecord): Omit<IssueAttachmentRecord, "storage_key"> {
  return attachment;
}

function publicDetail(detail: IssueDetail, pagePath: string, viewerId?: string | null): Omit<IssueDetail, "attachments"> & { attachments: Array<Omit<IssueAttachmentRecord, "storage_key"> & { url: string }> } {
  const viewerSubscribed = Boolean(viewerId && detail.collaboration.subscriber_ids.includes(viewerId));
  return {
    ...detail,
    timeline: detail.timeline.filter((item) => item.kind !== "event" || !["subscribed", "unsubscribed"].includes(item.event.event_type) || item.event.actor_id === viewerId),
    collaboration: {
      ...detail.collaboration,
      subscriber_ids: viewerSubscribed && viewerId ? [viewerId] : [],
    },
    attachments: detail.attachments.map((attachment) => ({
      ...publicAttachment(attachment),
      url: issueAttachmentUrl(pagePath, attachment.id),
    })),
  };
}

class InvalidIssueAttachmentsError extends Error {}
class InvalidIssueDuplicateError extends Error {
  constructor(readonly result: Exclude<InsertIssueDuplicateResult, "created">) { super(result); }
}
class InvalidIssueSubIssueError extends Error {
  constructor(readonly result: AddIssueSubIssueResult) {
    super(result);
  }
}

const ISSUE_SUB_ISSUE_ERRORS: Record<Exclude<AddIssueSubIssueResult, "added" | "not_found">, { code: string; error: string }> = {
  self_reference: { code: "issue_sub_issue_self_reference", error: "Issue 不能作为自己的子项" },
  duplicate: { code: "issue_sub_issue_duplicate", error: "该 Issue 已是当前父项的子项" },
  has_parent: { code: "issue_sub_issue_has_parent", error: "该 Issue 已有父项" },
  cycle: { code: "issue_sub_issue_cycle", error: "父子关系不能形成循环" },
  limit: { code: "issue_sub_issue_limit_exceeded", error: "每个 Issue 最多包含 100 个直接子项" },
  depth: { code: "issue_sub_issue_depth_exceeded", error: "Issue 层级最多为 8 层" },
};
const ISSUE_DEPENDENCY_ERRORS: Record<Exclude<AddIssueDependencyResult, "added" | "not_found">, { code: string; error: string }> = {
  self_reference: { code: "issue_dependency_self_reference", error: "Issue 不能依赖自身" },
  duplicate: { code: "issue_dependency_duplicate", error: "该依赖关系已存在" },
  cycle: { code: "issue_dependency_cycle", error: "Issue 依赖不能形成循环" },
  limit: { code: "issue_dependency_limit_exceeded", error: "每个 Issue 每个方向最多包含 100 条直接依赖" },
};
const ISSUE_DUPLICATE_ERRORS: Record<Exclude<InsertIssueDuplicateResult, "created" | "not_found">, { code: string; error: string }> = {
  self_reference: { code: "issue_duplicate_self_reference", error: "Issue 不能标记为自身的重复项" },
  already_marked: { code: "issue_duplicate_already_marked", error: "该 Issue 已标记为重复项" },
  canonical_is_duplicate: { code: "issue_duplicate_canonical_is_duplicate", error: "目标 Issue 本身已是重复项" },
  has_duplicates: { code: "issue_duplicate_has_duplicates", error: "已有重复项的 canonical Issue 不能再标记为重复项" },
};
const ISSUE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

interface IssueEventClient {
  pagePath: string;
  write: (event: IssueChangedEvent) => void;
}

interface IssueChangedEvent {
  type: "issue:changed";
  data: { pagePath: string; issueId: number | null; kind: string; updatedAt: string };
}

const issueEventClients = new Set<IssueEventClient>();

function publishIssueChanged(pagePath: string, issueId: number | null, kind: string): void {
  const event: IssueChangedEvent = { type: "issue:changed", data: { pagePath, issueId, kind, updatedAt: new Date().toISOString() } };
  for (const client of issueEventClients) {
    if (client.pagePath === pagePath) client.write(event);
  }
}

function parseNumericId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const ISSUE_LIST_QUERY_KEYS = new Set([
  "pagePath",
  "q",
  "in",
  "status",
  "label",
  "type",
  "author",
  "participant",
  "assignee",
  "milestone",
  "reason",
  "subscribed",
  "mentioned",
  "locked",
  "sort",
  "direction",
  "limit",
  "offset",
]);

type ParsedIssueListQuery =
  | { pagePath: string; options: IssueListOptions; subscribed: boolean; mentioned: boolean }
  | { error: string };

function parseIssueListQuery(rawQuery: unknown, rawUrl?: string): ParsedIssueListQuery {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    return { error: "Invalid Issue query parameters" };
  }
  const query = rawQuery as Record<string, unknown>;

  if (rawUrl !== undefined) {
    try {
      const searchParams = new URL(rawUrl, "http://localhost").searchParams;
      const seen = new Set<string>();
      for (const key of searchParams.keys()) {
        if (seen.has(key)) return { error: "Invalid Issue query parameters" };
        seen.add(key);
      }
    } catch {
      return { error: "Invalid Issue query parameters" };
    }
  }
  if (Object.keys(query).some((key) => !ISSUE_LIST_QUERY_KEYS.has(key))) {
    return { error: "Invalid Issue query parameters" };
  }
  if (Object.values(query).some((value) => typeof value !== "string")) {
    return { error: "Invalid Issue query parameters" };
  }

  const pagePath = query.pagePath;
  if (typeof pagePath !== "string" || !pagePath) {
    return { error: "pagePath query parameter is required" };
  }

  const status = query.status;
  if (status !== undefined && status !== "open" && status !== "closed") {
    return { error: "Invalid Issue query parameters" };
  }
  const label = query.label;
  if (label !== undefined && (typeof label !== "string" || !label || label.length > 100)) {
    return { error: "Invalid Issue query parameters" };
  }
  const issueType = query.type;
  if (issueType !== undefined && !isIssueType(issueType)) return { error: "Invalid Issue query parameters" };
  const milestone = query.milestone;
  if (milestone !== undefined && (typeof milestone !== "string" || (milestone !== "none" && (!/^\d+$/.test(milestone) || Number(milestone) < 1)))) {
    return { error: "Invalid Issue query parameters" };
  }
  const reason = query.reason;
  if (reason !== undefined && reason !== "completed" && reason !== "not_planned") return { error: "Invalid Issue query parameters" };
  const locked = query.locked;
  if (locked !== undefined && locked !== "true" && locked !== "false") return { error: "Invalid Issue query parameters" };
  const subscribed = query.subscribed;
  if (subscribed !== undefined && subscribed !== "true") return { error: "Invalid Issue query parameters" };
  const mentioned = query.mentioned;
  const searchIn = query.in;
  const searchScopes = searchIn === undefined ? undefined : parseIssueSearchScopes(searchIn);
  if (searchIn !== undefined && searchScopes === null) return { error: "Invalid Issue query parameters" };
  if (mentioned !== undefined && mentioned !== "true") return { error: "Invalid Issue query parameters" };

  const sort = query.sort === undefined ? "activity" : query.sort;
  if (sort !== "activity" && sort !== "created" && sort !== "updated" && sort !== "comments") {
    return { error: "Invalid Issue query parameters" };
  }
  const direction = query.direction === undefined ? "desc" : query.direction;
  if (direction !== "asc" && direction !== "desc") {
    return { error: "Invalid Issue query parameters" };
  }

  const limitValue = query.limit as string | undefined;
  const limit = limitValue === undefined ? 25 : Number(limitValue);
  if (limitValue !== undefined && (!/^\d+$/.test(limitValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    return { error: "Invalid Issue query parameters" };
  }
  const offsetValue = query.offset as string | undefined;
  const offset = offsetValue === undefined ? 0 : Number(offsetValue);
  if (offsetValue !== undefined && (!/^\d+$/.test(offsetValue) || !Number.isSafeInteger(offset))) {
    return { error: "Invalid Issue query parameters" };
  }

  const options: IssueListOptions = {
    sort: sort as IssueListSort,
    direction: direction as IssueListDirection,
    limit,
    offset,
  };
  if (typeof query.q === "string") options.q = query.q;
  if (searchScopes !== undefined && searchScopes !== null) options.searchIn = searchScopes;
  if (status !== undefined) options.status = status;
  if (label !== undefined) options.label = label;
  if (issueType !== undefined) options.issueType = issueType;
  if (typeof query.author === "string") options.author = query.author;
  if (typeof query.participant === "string") options.participant = query.participant;
  if (typeof query.assignee === "string") options.assignee = query.assignee;
  if (milestone !== undefined) options.milestone = milestone === "none" ? "none" : Number(milestone);
  if (reason !== undefined) options.reason = reason;
  if (locked !== undefined) options.locked = locked === "true";
  return { pagePath, options, subscribed: subscribed === "true", mentioned: mentioned === "true" };
}

  const publicSavedReply = ({ userId: _userId, ...reply }: SavedReplyRecord) => reply;
  const requireSavedReplyUser = (reply: FastifyReply, visitorId: string | null | undefined): visitorId is string => {
    if (visitorId) return true;
    reply.status(401).send({ success: false, error: "Authentication required" });
    return false;
  };
  const sendSavedReplyError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof Error && error.message === "SAVED_REPLY_LIMIT_EXCEEDED") return reply.status(409).send({ success: false, code: "issue_saved_reply_limit_exceeded", error: "每位用户最多保存 100 条回复" });
    if (error instanceof Error && error.message === "SAVED_REPLY_TITLE_CONFLICT") return reply.status(409).send({ success: false, code: "issue_saved_reply_title_conflict", error: "已存在同名保存回复" });
    if (error instanceof Error && error.message.startsWith("INVALID_SAVED_REPLY")) return reply.status(400).send({ success: false, error: "Invalid saved reply request" });
    throw error;
  };

  app.get("/api/issues/saved-replies", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!requireSavedReplyUser(reply, visitorId)) return;
    if (Object.keys(req.query as Record<string, unknown>).length > 0) return reply.status(400).send({ success: false, error: "Invalid saved reply query" });
    return { success: true, data: listSavedReplies(visitorId).map(publicSavedReply) };
  });

  app.post("/api/issues/saved-replies", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!requireSavedReplyUser(reply, visitorId)) return;
    try {
      const data = createSavedReply(visitorId, req.body as { title: string; body: string });
      return reply.status(201).send({ success: true, data: publicSavedReply(data) });
    } catch (error) { return sendSavedReplyError(reply, error); }
  });

  app.patch<{ Params: { id: string } }>("/api/issues/saved-replies/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!requireSavedReplyUser(reply, visitorId)) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.status(400).send({ success: false, error: "Invalid saved reply id" });
    try {
      const data = updateSavedReply(visitorId, id, req.body as { title: string; body: string });
      return data ? { success: true, data: publicSavedReply(data) } : reply.status(404).send({ success: false, error: "Saved reply not found" });
    } catch (error) { return sendSavedReplyError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/api/issues/saved-replies/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!requireSavedReplyUser(reply, visitorId)) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.status(400).send({ success: false, error: "Invalid saved reply id" });
    return deleteSavedReply(visitorId, id) ? { success: true } : reply.status(404).send({ success: false, error: "Saved reply not found" });
  });

  function resolveAppDb(pagePath: string): { dbPath: string; pageDir: string; userId: string; name: string } | null {
    const segments = pagePath.split("/");
    if (segments.length !== 2) return null;
    const [userId, name] = segments;
    if (!userId || !name || userId === "." || userId === ".." || name === "." || name === ".." || userId.includes("\\") || name.includes("\\")) {
      return null;
    }
    const pageDir = getPageDir(host.dataDir, userId, name);
    if (!fs.existsSync(pageDir)) return null;
    return { dbPath: getDbPath(pageDir), pageDir, userId, name };
  }

  function ensureAppAccess(
    reply: FastifyReply,
    resolved: { userId: string; name: string },
    visitorId: string | null | undefined,
    anonymousDeniedStatus: 401 | 403 = 401,
  ): boolean {
    const meta = readPageMeta(host.dataDir, resolved.userId, resolved.name);
    if (meta && checkPageAccess(meta.pageAccess, visitorId, resolved.userId)) return true;
    const status = visitorId ? 403 : anonymousDeniedStatus;
    reply.status(status).send({
      success: false,
      error: status === 401 ? "Authentication required" : "Access denied",
    });
    return false;
  }

  function isOwner(resolved: { userId: string }, visitorId: string | null | undefined): boolean {
    return Boolean(visitorId && visitorId === resolved.userId);
  }

  function validLabelInput(body: unknown): body is { pagePath: string; name: string; color: string; description?: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const value = body as Record<string, unknown>;
    return typeof value.pagePath === "string"
      && typeof value.name === "string" && value.name.trim().length > 0 && value.name.trim().length <= 50
      && typeof value.color === "string" && /^[0-9a-fA-F]{6}$/.test(value.color)
      && (value.description === undefined || (typeof value.description === "string" && value.description.length <= 200));
  }

  function validMilestoneInput(body: unknown, allowState = false): body is { pagePath: string; title: string; description?: string; dueOn?: string | null; state?: "open" | "closed" } {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const value = body as Record<string, unknown>;
    return typeof value.pagePath === "string"
      && typeof value.title === "string" && value.title.trim().length > 0 && value.title.trim().length <= 100
      && (value.description === undefined || (typeof value.description === "string" && value.description.length <= 1000))
      && (value.dueOn === undefined || value.dueOn === null || (typeof value.dueOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.dueOn)))
      && (value.state === undefined || (allowState && (value.state === "open" || value.state === "closed")));
  }

  app.get("/api/issues/events", async (req, reply) => {
    const visitorId = host.visitor(req);
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const client: IssueEventClient = {
      pagePath,
      write: (event) => {
        reply.raw.write("event: issue:changed\n");
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      },
    };
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    issueEventClients.add(client);
    req.raw.on("close", () => issueEventClients.delete(client));
    reply.hijack();
  });

  app.addHook("onResponse", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!new Set(["POST", "PATCH", "PUT", "DELETE"]).has(req.method) || reply.statusCode < 200 || reply.statusCode >= 300) return;
    const url = new URL(req.raw.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/issues") || url.pathname === "/api/issues" || url.pathname.startsWith("/api/issues/attachments")) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const pagePath = typeof body.pagePath === "string" ? body.pagePath : url.searchParams.get("pagePath");
    if (!pagePath) return;
    const match = url.pathname.match(/^\/api\/issues\/(\d+)(?:\/|$)/);
    const issueId = match ? Number(match[1]) : null;
    const suffix = url.pathname.replace(/^\/api\/issues\/?/, "") || "issue";
    publishIssueChanged(pagePath, issueId, `${req.method.toLowerCase()}:${suffix}`);
    if (issueId !== null) {
      const resolved = resolveAppDb(pagePath);
      if (resolved) {
        try {
          const ancestors = await listIssueAncestorIds(resolved.dbPath, issueId);
          ancestors.forEach((ancestorId) => publishIssueChanged(pagePath, ancestorId, `descendant:${req.method.toLowerCase()}:${suffix}`));
        } catch (error) {
          req.log.warn({ err: error, issueId }, "Failed to publish ancestor Issue changes");
        }
      }
    }
  });

  // GET /api/issues?pagePath=...&status=...&label=...
  app.get("/api/issues/config", async (req, reply) => {
    const visitorId = host.visitor(req);
    let searchParams: URLSearchParams;
    try { searchParams = new URL(req.raw.url ?? "", "http://localhost").searchParams; }
    catch { return reply.status(400).send({ success: false, error: "Invalid Issue config query" }); }
    const query = req.query as Record<string, unknown>;
    if (Array.from(searchParams.keys()).some((key) => key !== "pagePath" || searchParams.getAll(key).length !== 1)
      || Object.keys(query).some((key) => key !== "pagePath")
      || typeof query.pagePath !== "string" || !query.pagePath) {
      return reply.status(400).send({ success: false, error: "Invalid Issue config query" });
    }
    const resolved = resolveAppDb(query.pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const meta = readPageMeta(host.dataDir, resolved.userId, resolved.name);
    return { success: true, data: { templates: meta?.issues?.templates ?? [] } };
  });

  const resolveSavedViewRequest = (reply: FastifyReply, pagePath: unknown, visitorId: string | null | undefined) => {
    if (!visitorId) { reply.status(401).send({ success: false, error: "Authentication required" }); return null; }
    if (typeof pagePath !== "string" || !pagePath) { reply.status(400).send({ success: false, error: "Invalid saved view request" }); return null; }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) { reply.status(404).send({ success: false, error: "Application not found" }); return null; }
    if (!ensureAppAccess(reply, resolved, visitorId)) return null;
    return { ...resolved, visitorId };
  };
  const sendSavedViewError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof IssueSavedViewLimitError) return reply.status(409).send({ success: false, code: "issue_saved_view_limit_exceeded", error: "每个应用最多保存 25 个 Issue 视图" });
    if (error instanceof TypeError || error instanceof RangeError) return reply.status(400).send({ success: false, error: error.message });
    if (error instanceof Error && error.message === "Saved view name already exists") return reply.status(409).send({ success: false, code: "issue_saved_view_name_conflict", error: "已存在同名保存视图" });
    throw error;
  };

  app.get("/api/issues/views", async (req, reply) => {
    const visitorId = host.visitor(req);
    const query = req.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => key !== "pagePath")) return reply.status(400).send({ success: false, error: "Invalid saved view query" });
    const context = resolveSavedViewRequest(reply, query.pagePath, visitorId);
    if (!context) return;
    return { success: true, data: await listIssueSavedViews(context.dbPath, context.visitorId) };
  });

  app.post("/api/issues/views", async (req, reply) => {
    const visitorId = host.visitor(req);
    const body = req.body as Record<string, unknown> | null;
    const context = resolveSavedViewRequest(reply, body?.pagePath, visitorId);
    if (!context) return;
    if (!body || Object.keys(body).some((key) => !["pagePath", "name", "description", "query"].includes(key))) return reply.status(400).send({ success: false, error: "Invalid saved view request" });
    try { return { success: true, data: await createIssueSavedView(context.dbPath, context.visitorId, { name: body.name as string, description: body.description as string | undefined, query: body.query }) }; }
    catch (error) { return sendSavedViewError(reply, error); }
  });

  app.patch<{ Params: { id: string } }>("/api/issues/views/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown> | null;
    if (!Number.isSafeInteger(id) || id < 1 || !body || Object.keys(body).some((key) => !["pagePath", "name", "description", "query"].includes(key))) return reply.status(400).send({ success: false, error: "Invalid saved view request" });
    const context = resolveSavedViewRequest(reply, body.pagePath, visitorId);
    if (!context) return;
    try {
      const data = await updateIssueSavedView(context.dbPath, context.visitorId, id, { name: body.name as string | undefined, description: body.description as string | undefined, query: body.query });
      return data ? { success: true, data } : reply.status(404).send({ success: false, error: "Saved view not found" });
    } catch (error) { return sendSavedViewError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/api/issues/views/:id/copy", async (req, reply) => {
    const visitorId = host.visitor(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown> | null;
    if (!Number.isSafeInteger(id) || id < 1 || !body || Object.keys(body).some((key) => key !== "pagePath")) return reply.status(400).send({ success: false, error: "Invalid saved view request" });
    const context = resolveSavedViewRequest(reply, body.pagePath, visitorId);
    if (!context) return;
    try {
      const data = await duplicateIssueSavedView(context.dbPath, context.visitorId, id);
      return data ? { success: true, data } : reply.status(404).send({ success: false, error: "Saved view not found" });
    } catch (error) { return sendSavedViewError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/api/issues/views/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown> | null;
    if (!Number.isSafeInteger(id) || id < 1 || !body || Object.keys(body).some((key) => key !== "pagePath")) return reply.status(400).send({ success: false, error: "Invalid saved view request" });
    const context = resolveSavedViewRequest(reply, body.pagePath, visitorId);
    if (!context) return;
    return await deleteIssueSavedView(context.dbPath, context.visitorId, id) ? { success: true } : reply.status(404).send({ success: false, error: "Saved view not found" });
  });

  // GET /api/issues?pagePath=...&status=...&label=...
  app.get("/api/issues/potential-duplicates", async (req, reply) => {
    const visitorId = host.visitor(req);
    const query = req.query as Record<string, unknown>;
    let searchParams: URLSearchParams;
    try { searchParams = new URL(req.raw.url ?? "", "http://localhost").searchParams; }
    catch { return reply.status(400).send({ success: false, error: "Invalid potential duplicate query" }); }
    const allowed = new Set(["pagePath", "title", "body"]);
    if (Array.from(searchParams.keys()).some((key) => !allowed.has(key) || searchParams.getAll(key).length !== 1)
      || Object.keys(query).some((key) => !allowed.has(key))
      || typeof query.pagePath !== "string" || !query.pagePath
      || typeof query.title !== "string" || Array.from(query.title.trim()).length > ISSUE_TITLE_MAX_CHARACTERS
      || typeof query.body !== "string" || Array.from(query.body).length > 20_000) {
      return reply.status(400).send({ success: false, error: "Invalid potential duplicate query" });
    }
    const resolved = resolveAppDb(query.pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    return { success: true, data: await listPotentialDuplicateIssues(resolved.dbPath, query.title, query.body) };
  });

  // GET /api/issues?pagePath=...&status=...&label=...
  app.get("/api/issues", async (req, reply) => {
    const visitorId = host.visitor(req);
    const parsed = parseIssueListQuery(req.query, req.raw.url);
    if ("error" in parsed) {
      return reply.status(400).send({ success: false, error: parsed.error });
    }
    const resolved = resolveAppDb(parsed.pagePath);
    if (!resolved) {
      return reply.status(404).send({ success: false, error: "Application not found" });
    }
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (parsed.subscribed && !visitorId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }
    if (parsed.mentioned && !visitorId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }
    if (parsed.subscribed) parsed.options.subscriberId = visitorId!;
    if (parsed.mentioned) parsed.options.mentionedUserId = visitorId!;
    const result = await listIssues(resolved.dbPath, parsed.options);
    return { success: true, data: result.data, pinned: result.pinned, meta: result.meta };
  });

  // POST /api/issues
  app.post("/api/issues", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }
    const { pagePath, title, description, issueType, label, draftId, attachmentIds, labelIds, assigneeIds, milestoneId, parentIssueId } = req.body as {
      pagePath?: string;
      title?: string;
      description?: string;
      issueType?: unknown;
      label?: string;
      draftId?: unknown;
      attachmentIds?: unknown;
      labelIds?: unknown;
      assigneeIds?: unknown;
      milestoneId?: unknown;
      parentIssueId?: unknown;
    };
    if (typeof pagePath !== "string" || typeof title !== "string" || !title.trim()
      || (description !== undefined && typeof description !== "string")
      || (issueType !== undefined && !isIssueType(issueType))
      || (label !== undefined && label !== "bug" && label !== "feature")) {
      return reply.status(400).send({ success: false, error: "pagePath and title are required" });
    }
    if (issueTitleTooLong(title)) {
      return reply.status(400).send({ success: false, code: "issue_title_too_long", error: "Issue 标题不能超过 256 个字符" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) {
      return reply.status(404).send({ success: false, error: "Application not found" });
    }
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string") || typeof draftId !== "string" || !draftId)) {
      return reply.status(400).send({ success: false, error: "draftId and attachmentIds are required for attachments" });
    }
    if ((labelIds !== undefined && (!Array.isArray(labelIds) || labelIds.length > 20 || labelIds.some((id) => typeof id !== "string")))
      || (assigneeIds !== undefined && (!Array.isArray(assigneeIds) || assigneeIds.length > 20 || assigneeIds.some((id) => typeof id !== "string")))) {
      return reply.status(400).send({ success: false, error: "Invalid Issue creation metadata" });
    }
    if (milestoneId !== undefined && (!Number.isInteger(milestoneId) || Number(milestoneId) < 1)) {
      return reply.status(400).send({ success: false, error: "Invalid Issue creation milestone" });
    }
    if (parentIssueId !== undefined && (!Number.isInteger(parentIssueId) || Number(parentIssueId) < 1)) {
      return reply.status(400).send({ success: false, error: "Invalid parent Issue" });
    }
    if ((labelIds !== undefined || assigneeIds !== undefined || milestoneId !== undefined || parentIssueId !== undefined) && !isOwner(resolved, visitorId)) {
      return reply.status(403).send({ success: false, error: "Only the app owner can set Issue creation metadata" });
    }
    const validIssueType: IssueType = isIssueType(issueType) ? issueType : label === "feature" ? "feature" : label === "bug" ? "bug" : "task";
    const uniqueLabelIds = labelIds === undefined ? undefined : Array.from(new Set(labelIds as string[]));
    const uniqueAssigneeIds = assigneeIds === undefined ? undefined : Array.from(new Set(assigneeIds as string[]));
    if (uniqueAssigneeIds?.some((userId) => !findUserById(userId))) {
      return reply.status(400).send({ success: false, error: "One or more assignees do not exist" });
    }
    const mentionUserIds = await resolveIssueMentionUserIds(`${title.trim()}\n\n${description || ""}`);
    const crossReferenceTargets = new Set<number>();
    let result;
    try {
      result = await runDbTransaction(resolved.dbPath, async () => {
        const created = await insertIssue(resolved.dbPath, title.trim(), description || "", validIssueType, visitorId!);
        const crossReferences = await reconcileIssueCrossReferences(resolved.dbPath, { sourceIssueId: created.id, sourceType: "issue", sourceId: created.id, actorId: visitorId!, markdown: description || "" });
        crossReferences.addedTargetIssueIds.forEach((targetId) => crossReferenceTargets.add(targetId));
        await insertIssueEvent(resolved.dbPath, created.id, visitorId!, "opened", {});
        await setIssueSubscription(resolved.dbPath, created.id, visitorId!, true);
        await replaceIssueMentions(resolved.dbPath, { issueId: created.id, targetType: "issue", targetId: created.id, userIds: mentionUserIds });
        if (uniqueLabelIds) {
          const before = await getIssueCollaborationMetadata(resolved.dbPath, created.id);
          await replaceIssueLabels(resolved.dbPath, created.id, uniqueLabelIds);
          const beforeIds = before.labels.map((item) => item.id);
          if (beforeIds.length !== uniqueLabelIds.length || beforeIds.some((id) => !uniqueLabelIds.includes(id))) {
            await insertIssueEvent(resolved.dbPath, created.id, visitorId!, "labels_changed", { from: beforeIds, to: uniqueLabelIds });
          }
        }
        if (uniqueAssigneeIds?.length) {
          await replaceIssueAssignees(resolved.dbPath, created.id, uniqueAssigneeIds, visitorId!);
          for (const userId of uniqueAssigneeIds) await setIssueSubscription(resolved.dbPath, created.id, userId, true);
          await insertIssueEvent(resolved.dbPath, created.id, visitorId!, "assignees_changed", { from: [], to: uniqueAssigneeIds });
        }
        if (typeof milestoneId === "number") {
          await setIssueMilestone(resolved.dbPath, created.id, milestoneId);
          await insertIssueEvent(resolved.dbPath, created.id, visitorId!, "milestoned", { milestoneId });
        }
        if (typeof parentIssueId === "number") {
          const relationResult = await addIssueSubIssue(resolved.dbPath, parentIssueId, created.id, visitorId!, { joinTransaction: true });
          if (relationResult !== "added") throw new InvalidIssueSubIssueError(relationResult);
        }
        if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
          const bound = await bindIssueAttachments(resolved.dbPath, {
            attachmentIds,
            draftId: draftId as string,
            uploaderId: visitorId!,
            issueId: created.id,
            pagePath,
          });
          if (bound.length !== attachmentIds.length) throw new InvalidIssueAttachmentsError();
        }
        return created;
      });
    } catch (error) {
      if (error instanceof InvalidIssueAttachmentsError) {
        return reply.status(400).send({ success: false, error: "One or more Issue attachments are invalid" });
      }
      if (error instanceof InvalidIssueSubIssueError) {
        if (error.result === "not_found") return reply.status(404).send({ success: false, error: "Parent Issue not found" });
        if (error.result === "added") throw error;
        const mapped = ISSUE_SUB_ISSUE_ERRORS[error.result];
        return reply.status(409).send({ success: false, ...mapped });
      }
      if (uniqueLabelIds || uniqueAssigneeIds || milestoneId !== undefined) {
        return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : "Invalid Issue creation metadata" });
      }
      throw error;
    }
    crossReferenceTargets.forEach((targetId) => publishIssueChanged(pagePath, targetId, "cross-reference:added"));
    const issue = await getIssueById(resolved.dbPath, result.id);
    if (uniqueAssigneeIds?.length) {
      persistNotifications(uniqueAssigneeIds.filter((userId) => userId !== visitorId).map((userId) => ({
        id: "",
        userId,
        appOwner: resolved.userId,
        appName: resolved.name,
        title: `你被分配到 Issue：${issue!.title}`,
        body: `#${issue!.issue_number}`,
        url: `/${resolved.userId}/${resolved.name}/`,
        priority: "normal" as const,
        data: { issueId: issue!.id, issueNumber: issue!.issue_number, type: "issue_assigned" },
      })));
    }
    try {
      await notifyIssueMentions({ dbPath: resolved.dbPath, markdown: `${issue!.title}\n\n${issue!.description}`, actorId: visitorId, appOwner: resolved.userId, appName: resolved.name, issue: issue! });
    } catch (notificationError) {
      req.log.error({ err: notificationError, issueId: result.id }, "Failed to persist Issue mention notifications");
    }
    publishIssueChanged(pagePath, issue!.id, "created");
    return { success: true, data: issue };
  });

  app.get("/api/issues/labels", async (req, reply) => {
    const visitorId = host.visitor(req);
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    return { success: true, data: await listIssueLabels(resolved.dbPath) };
  });

  app.post("/api/issues/labels", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    if (!validLabelInput(req.body)) return reply.status(400).send({ success: false, error: "Invalid Issue label" });
    const { pagePath, name, color, description } = req.body;
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue labels" });
    let label;
    try {
      label = await createIssueLabel(resolved.dbPath, {
        id: randomUUID(), name: name.trim(), color: color.toLowerCase(), description: description?.trim(),
      });
    } catch {
      return reply.status(400).send({ success: false, error: "Issue label name already exists" });
    }
    return reply.status(201).send({ success: true, data: label });
  });

  app.patch<{ Params: { labelId: string } }>("/api/issues/labels/:labelId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    if (!validLabelInput(req.body)) return reply.status(400).send({ success: false, error: "Invalid Issue label" });
    const { pagePath, name, color, description } = req.body;
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue labels" });
    let label;
    try {
      label = await updateIssueLabel(resolved.dbPath, req.params.labelId, {
        name: name.trim(), color: color.toLowerCase(), description: description?.trim() ?? "",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return reply.status(400).send({ success: false, error: message.includes("UNIQUE") ? "Issue label name already exists" : message || "Issue label cannot be edited" });
    }
    if (!label) return reply.status(404).send({ success: false, error: "Issue label not found" });
    return { success: true, data: label };
  });

  app.delete<{ Params: { labelId: string } }>("/api/issues/labels/:labelId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue labels" });
    try {
      if (!await deleteIssueLabel(resolved.dbPath, req.params.labelId)) return reply.status(404).send({ success: false, error: "Issue label not found" });
    } catch (error) {
      return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : "Issue label cannot be deleted" });
    }
    return { success: true };
  });

  app.get("/api/issues/milestones", async (req, reply) => {
    const visitorId = host.visitor(req);
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    return { success: true, data: await listIssueMilestones(resolved.dbPath) };
  });

  app.post("/api/issues/milestones", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    if (!validMilestoneInput(req.body)) return reply.status(400).send({ success: false, error: "Invalid Issue milestone" });
    const { pagePath, title, description, dueOn } = req.body;
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue milestones" });
    try {
      const milestone = await createIssueMilestone(resolved.dbPath, { title: title.trim(), description: description?.trim(), dueOn, createdBy: visitorId });
      return reply.status(201).send({ success: true, data: milestone });
    } catch {
      return reply.status(400).send({ success: false, error: "Issue milestone title already exists" });
    }
  });

  app.patch<{ Params: { milestoneId: string } }>("/api/issues/milestones/:milestoneId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const milestoneId = parseNumericId(req.params.milestoneId);
    if (milestoneId === null || !validMilestoneInput(req.body, true)) return reply.status(400).send({ success: false, error: "Invalid Issue milestone" });
    const { pagePath, title, description, dueOn, state } = req.body;
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue milestones" });
    try {
      const milestone = await updateIssueMilestone(resolved.dbPath, milestoneId, { title: title.trim(), description: description?.trim() ?? "", dueOn, state });
      if (!milestone) return reply.status(404).send({ success: false, error: "Issue milestone not found" });
      return { success: true, data: milestone };
    } catch {
      return reply.status(400).send({ success: false, error: "Issue milestone title already exists" });
    }
  });

  app.delete<{ Params: { milestoneId: string } }>("/api/issues/milestones/:milestoneId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const milestoneId = parseNumericId(req.params.milestoneId);
    const { pagePath } = req.query as { pagePath?: string };
    if (milestoneId === null || !pagePath) return reply.status(400).send({ success: false, error: "Invalid Issue milestone delete" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue milestones" });
    if (!await deleteIssueMilestone(resolved.dbPath, milestoneId)) return reply.status(404).send({ success: false, error: "Issue milestone not found" });
    return { success: true };
  });

  app.put<{ Params: { id: string } }>("/api/issues/:id/milestone", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const { pagePath, milestoneId } = req.body as { pagePath?: unknown; milestoneId?: unknown };
    if (id === null || typeof pagePath !== "string" || (milestoneId !== null && (!Number.isInteger(milestoneId) || Number(milestoneId) < 1))) {
      return reply.status(400).send({ success: false, error: "Invalid Issue milestone update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can change Issue milestones" });
    const before = await getIssueById(resolved.dbPath, id);
    if (!before) return reply.status(404).send({ success: false, error: "Issue not found" });
    try {
      await runDbTransaction(resolved.dbPath, async () => {
        await setIssueMilestone(resolved.dbPath, id, milestoneId as number | null);
        await insertIssueEvent(resolved.dbPath, id, visitorId!, milestoneId === null ? "demilestoned" : "milestoned", { from: before.milestone_id, to: milestoneId });
      });
    } catch (error) {
      return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : "Invalid Issue milestone" });
    }
    return { success: true, data: await getIssueDetail(resolved.dbPath, id) };
  });

  app.put<{ Params: { id: string } }>("/api/issues/:id/labels", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const { pagePath, labelIds } = req.body as { pagePath?: unknown; labelIds?: unknown };
    if (id === null || typeof pagePath !== "string" || !Array.isArray(labelIds) || labelIds.length > 20 || labelIds.some((value) => typeof value !== "string")) {
      return reply.status(400).send({ success: false, error: "Invalid Issue labels update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can change Issue labels" });
    if (!await getIssueById(resolved.dbPath, id)) return reply.status(404).send({ success: false, error: "Issue not found" });
    try {
      await runDbTransaction(resolved.dbPath, async () => {
        const before = await getIssueCollaborationMetadata(resolved.dbPath, id);
        await replaceIssueLabels(resolved.dbPath, id, labelIds as string[]);
        const after = await getIssueCollaborationMetadata(resolved.dbPath, id);
        await insertIssueEvent(resolved.dbPath, id, visitorId!, "labels_changed", {
          from: before.labels.map((label) => label.id), to: after.labels.map((label) => label.id),
        });
      });
    } catch (error) {
      return reply.status(400).send({ success: false, error: error instanceof Error ? error.message : "Invalid Issue labels" });
    }
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, pagePath, visitorId) };
  });

  app.put<{ Params: { id: string } }>("/api/issues/:id/assignees", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const { pagePath, userIds } = req.body as { pagePath?: unknown; userIds?: unknown };
    if (id === null || typeof pagePath !== "string" || !Array.isArray(userIds) || userIds.length > 20 || userIds.some((value) => typeof value !== "string")) {
      return reply.status(400).send({ success: false, error: "Invalid Issue assignees update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can change Issue assignees" });
    const issue = await getIssueById(resolved.dbPath, id);
    if (!issue) return reply.status(404).send({ success: false, error: "Issue not found" });
    const uniqueUserIds = Array.from(new Set(userIds as string[]));
    if (uniqueUserIds.some((userId) => !findUserById(userId))) return reply.status(400).send({ success: false, error: "One or more assignees do not exist" });
    let newlyAssigned: string[] = [];
    await runDbTransaction(resolved.dbPath, async () => {
      const before = await getIssueCollaborationMetadata(resolved.dbPath, id);
      const addedAssignees = uniqueUserIds.filter((userId) => !before.assignee_ids.includes(userId));
      newlyAssigned = addedAssignees.filter((userId) => userId !== visitorId);
      await replaceIssueAssignees(resolved.dbPath, id, uniqueUserIds, visitorId!);
      for (const userId of addedAssignees) await setIssueSubscription(resolved.dbPath, id, userId, true);
      await insertIssueEvent(resolved.dbPath, id, visitorId!, "assignees_changed", { from: before.assignee_ids, to: uniqueUserIds });
    });
    persistNotifications(newlyAssigned.map((userId) => ({
      id: "",
      userId,
      appOwner: resolved.userId,
      appName: resolved.name,
      title: `你被分配到 Issue：${issue.title}`,
      body: `#${issue.issue_number}`,
      url: `/${resolved.userId}/${resolved.name}/`,
      priority: "normal" as const,
      data: { issueId: id, issueNumber: issue.issue_number, type: "issue_assigned" },
    })));
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, pagePath, visitorId) };
  });

  app.put<{ Params: { id: string } }>("/api/issues/:id/subscription", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const { pagePath, subscribed } = req.body as { pagePath?: unknown; subscribed?: unknown };
    if (id === null || typeof pagePath !== "string" || typeof subscribed !== "boolean") {
      return reply.status(400).send({ success: false, error: "Invalid Issue subscription update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!await getIssueById(resolved.dbPath, id)) return reply.status(404).send({ success: false, error: "Issue not found" });
    await runDbTransaction(resolved.dbPath, async () => {
      const before = await getIssueCollaborationMetadata(resolved.dbPath, id);
      await setIssueSubscription(resolved.dbPath, id, visitorId!, subscribed);
      if (before.subscriber_ids.includes(visitorId!) !== subscribed) {
        await insertIssueEvent(resolved.dbPath, id, visitorId!, subscribed ? "subscribed" : "unsubscribed", {});
      }
    });
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, pagePath, visitorId) };
  });

  app.put<{ Params: { id: string } }>("/api/issues/:id/lock", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const { pagePath, locked, reason } = req.body as { pagePath?: unknown; locked?: unknown; reason?: unknown };
    if (id === null || typeof pagePath !== "string" || typeof locked !== "boolean" || (reason !== undefined && !isIssueLockReason(reason)) || (!locked && reason !== undefined)) {
      return reply.status(400).send({ success: false, error: "Invalid Issue lock update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const issue = await getIssueById(resolved.dbPath, id);
    if (!issue) return reply.status(404).send({ success: false, error: "Issue not found" });
    if (issue.reporter_id !== visitorId && resolved.userId !== visitorId) {
      return reply.status(403).send({ success: false, error: "Only the app owner or Issue reporter can lock this conversation" });
    }
    const currentlyLocked = issue.locked_at !== null;
    if (currentlyLocked !== locked) {
      await runDbTransaction(resolved.dbPath, async () => {
        const currentIssue = await getIssueById(resolved.dbPath, id);
        if (!currentIssue) throw new Error("Issue disappeared during lock update");
        if ((currentIssue.locked_at !== null) === locked) return;
        await setIssueLock(resolved.dbPath, id, locked ? visitorId! : null, locked && isIssueLockReason(reason) ? reason : null);
        await insertIssueEvent(resolved.dbPath, id, visitorId!, locked ? "locked" : "unlocked", locked && isIssueLockReason(reason) ? { reason } : {});
      });
    }
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, pagePath, visitorId) };
  });

  app.put<{ Params: { id: string } }>("/api/issues/:id/pin", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (id === null || typeof body.pagePath !== "string" || typeof body.pinned !== "boolean") {
      return reply.status(400).send({ success: false, error: "Invalid Issue pin update" });
    }
    const resolved = resolveAppDb(body.pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (resolved.userId !== visitorId) return reply.status(403).send({ success: false, error: "Only the app owner can pin Issues" });
    const result = await setIssuePin(resolved.dbPath, id, visitorId, body.pinned);
    if (result === "not_found") return reply.status(404).send({ success: false, error: "Issue not found" });
    if (result === "limit") return reply.status(409).send({ success: false, code: "issue_pin_limit_exceeded", error: "每个应用最多置顶 3 条 Issue" });
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, body.pagePath, visitorId) };
  });

  const updateCommentPin = async (req: FastifyRequest<{ Params: { id: string; commentId: string } }>, reply: FastifyReply, pinned: boolean) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const issueId = parseNumericId(req.params.id);
    const commentId = parseNumericId(req.params.commentId);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (issueId === null || commentId === null || typeof body.pagePath !== "string") {
      return reply.status(400).send({ success: false, error: "Invalid Issue comment pin update" });
    }
    const resolved = resolveAppDb(body.pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can pin Issue comments" });
    const result = await setIssueCommentPin(resolved.dbPath, issueId, commentId, visitorId, pinned);
    if (result === "not_found") return reply.status(404).send({ success: false, error: "Comment not found" });
    if (result === "conflict") return reply.status(409).send({ success: false, code: "issue_comment_pin_conflict", error: "This Issue already has a pinned comment" });
    publishIssueChanged(body.pagePath, issueId, pinned ? "comment:pinned" : "comment:unpinned");
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, issueId))!, body.pagePath, visitorId) };
  };

  app.put<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId/pin", (req, reply) => updateCommentPin(req, reply, true));
  app.delete<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId/pin", (req, reply) => updateCommentPin(req, reply, false));

  const updateCommentMinimized = async (req: FastifyRequest<{ Params: { id: string; commentId: string } }>, reply: FastifyReply, minimized: boolean) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const issueId = parseNumericId(req.params.id);
    const commentId = parseNumericId(req.params.commentId);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (issueId === null || commentId === null || typeof body.pagePath !== "string" || (minimized && !isIssueCommentMinimizedReason(body.reason))) {
      return reply.status(400).send({ success: false, code: "issue_comment_minimized_reason_invalid", error: "Invalid Issue comment minimization update" });
    }
    const resolved = resolveAppDb(body.pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can minimize Issue comments" });
    const result = await setIssueCommentMinimized(resolved.dbPath, issueId, commentId, visitorId, minimized && isIssueCommentMinimizedReason(body.reason) ? body.reason : null);
    if (result === "not_found") return reply.status(404).send({ success: false, error: "Comment not found" });
    if (result === "pinned_conflict") return reply.status(409).send({ success: false, code: "issue_comment_minimized_pinned_conflict", error: "Unpin this comment before minimizing it" });
    if (result === "invalid_reason") return reply.status(400).send({ success: false, code: "issue_comment_minimized_reason_invalid", error: "Invalid Issue comment minimization reason" });
    publishIssueChanged(body.pagePath, issueId, minimized ? "comment:minimized" : "comment:unminimized");
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, issueId))!, body.pagePath, visitorId) };
  };

  app.put<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId/minimize", (req, reply) => updateCommentMinimized(req, reply, true));
  app.delete<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId/minimize", (req, reply) => updateCommentMinimized(req, reply, false));

  app.put<{ Params: { id: string } }>("/api/issues/:id/reactions", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const pagePath = body.pagePath;
    const commentId = body.commentId === undefined ? undefined : typeof body.commentId === "number" && Number.isSafeInteger(body.commentId) && body.commentId > 0 ? body.commentId : null;
    if (id === null || typeof pagePath !== "string" || !isIssueReactionContent(body.content) || typeof body.reacted !== "boolean" || commentId === null) {
      return reply.status(400).send({ success: false, error: "Invalid Issue reaction update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const content = body.content;
    const reacted = body.reacted;
    const result = await runDbTransaction(resolved.dbPath, async (): Promise<Awaited<ReturnType<typeof setIssueReaction>> | "locked"> => {
      const issue = await getIssueById(resolved.dbPath, id);
      if (!issue) return "target_not_found";
      if (reacted && issue.locked_at !== null) return "locked";
      return setIssueReaction(resolved.dbPath, {
        issueId: id,
        commentId,
        userId: visitorId!,
        content,
        reacted,
      });
    });
    if (result === "locked") return reply.status(409).send({ success: false, code: "issue_locked", error: "This Issue conversation is locked" });
    if (result === "target_not_found") return reply.status(404).send({ success: false, error: commentId ? "Comment not found" : "Issue not found" });
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, pagePath, visitorId) };
  });

  app.get<{ Params: { issueNumber: string } }>("/api/issues/by-number/:issueNumber", async (req, reply) => {
    const visitorId = host.visitor(req);
    const issueNumber = parseNumericId(req.params.issueNumber);
    if (issueNumber === null) return reply.status(400).send({ success: false, error: "Invalid issue number" });
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const detail = await getIssueDetailByNumber(resolved.dbPath, issueNumber);
    if (!detail) return reply.status(404).send({ success: false, error: "Issue not found" });
    return { success: true, data: publicDetail(detail, pagePath, visitorId) };
  });

  // GET /api/issues/:id?pagePath=...
  app.get<{ Params: { id: string } }>("/api/issues/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    const id = parseNumericId(req.params.id);
    if (id === null) {
      return reply.status(400).send({ success: false, error: "Invalid issue id" });
    }
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) {
      return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) {
      return reply.status(404).send({ success: false, error: "Application not found" });
    }
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const detail = await getIssueDetail(resolved.dbPath, id);
    if (!detail) {
      return reply.status(404).send({ success: false, error: "Issue not found" });
    }
    return { success: true, data: publicDetail(detail, pagePath, visitorId) };
  });

  // DELETE /api/issues/:id?pagePath=...
  app.delete<{ Params: { id: string } }>("/api/issues/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    if (id === null) return reply.status(400).send({ success: false, error: "Invalid issue id" });
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (visitorId !== resolved.userId) return reply.status(403).send({ success: false, error: "Only the app owner can delete Issues" });
    const attachments = await runDbTransaction(resolved.dbPath, async () => {
      const deleted = await deleteIssue(resolved.dbPath, id);
      if (!deleted) return null;
      for (const attachment of deleted) {
        try { await withAppDataObjectWrite(resolved.pageDir, () => deleteObject(attachment.storage_key)); }
        catch (error) { req.log.warn({ err: error, attachmentId: attachment.id }, "Failed to delete Issue attachment object"); }
      }
      return deleted;
    });
    if (!attachments) return reply.status(404).send({ success: false, error: "Issue not found" });
    return { success: true, data: { id } };
  });

  // PATCH /api/issues/:id
  app.patch<{ Params: { id: string } }>("/api/issues/:id", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }
    const id = parseNumericId(req.params.id);
    if (id === null) {
      return reply.status(400).send({ success: false, error: "Invalid issue id" });
    }
    const { pagePath, status, stateReason, issueType, label, title, description, expectedUpdatedAt, draftId, attachmentIds, removedAttachmentIds } = req.body as {
      pagePath?: string;
      status?: string;
      stateReason?: unknown;
      issueType?: unknown;
      label?: string;
      title?: unknown;
      description?: unknown;
      expectedUpdatedAt?: unknown;
      draftId?: unknown;
      attachmentIds?: unknown;
      removedAttachmentIds?: unknown;
    };
    if (!pagePath) {
      return reply.status(400).send({ success: false, error: "pagePath is required" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) {
      return reply.status(404).send({ success: false, error: "Application not found" });
    }
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const issue = await getIssueById(resolved.dbPath, id);
    if (!issue) {
      return reply.status(404).send({ success: false, error: "Issue not found" });
    }
    // Permission: reporter or app owner
    if (issue.reporter_id !== visitorId && visitorId !== resolved.userId) {
      return reply.status(403).send({ success: false, error: "Permission denied" });
    }
    if ((issueType !== undefined || label !== undefined) && visitorId !== resolved.userId) {
      return reply.status(403).send({ success: false, error: "Only the app owner can change Issue type" });
    }
    if ((status !== undefined && status !== "open" && status !== "closed")
      || (label !== undefined && label !== "bug" && label !== "feature")
      || (issueType !== undefined && !isIssueType(issueType))
      || (title !== undefined && (typeof title !== "string" || !title.trim()))
      || (description !== undefined && typeof description !== "string")
      || (stateReason !== undefined && stateReason !== null && stateReason !== "completed" && stateReason !== "not_planned")
      || (expectedUpdatedAt !== undefined && typeof expectedUpdatedAt !== "string")
      || (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.some((attachmentId) => typeof attachmentId !== "string") || typeof draftId !== "string" || !draftId))
      || (removedAttachmentIds !== undefined && (!Array.isArray(removedAttachmentIds) || removedAttachmentIds.some((attachmentId) => typeof attachmentId !== "string")))) {
      return reply.status(400).send({ success: false, error: "Invalid Issue update" });
    }
    if (typeof title === "string" && issueTitleTooLong(title)) {
      return reply.status(400).send({ success: false, code: "issue_title_too_long", error: "Issue 标题不能超过 256 个字符" });
    }
    const targetStatus = status ?? issue.status;
    if (targetStatus === "open" && stateReason !== undefined && stateReason !== null) {
      return reply.status(400).send({ success: false, error: "Open Issues cannot have a state reason" });
    }
    const updates: { status?: string; stateReason?: "completed" | "not_planned" | null; issueType?: IssueType; title?: string; description?: string } = {};
    if (status === "open" || status === "closed") updates.status = status;
    if (targetStatus === "open" && (status === "open" || stateReason === null)) updates.stateReason = null;
    if (targetStatus === "closed") updates.stateReason = stateReason === "not_planned" ? "not_planned" : stateReason === "completed" ? "completed" : issue.state_reason ?? "completed";
    if (isIssueType(issueType)) updates.issueType = issueType;
    else if (label === "bug" || label === "feature") updates.issueType = label;
    if (typeof title === "string") updates.title = title.trim();
    if (typeof description === "string") updates.description = description;
    const mentionUserIds = await resolveIssueMentionUserIds(`${updates.title ?? issue.title}\n\n${updates.description ?? issue.description}`);
    const removedIds = Array.isArray(removedAttachmentIds) ? removedAttachmentIds as string[] : [];
    const existingDetail = await getIssueDetail(resolved.dbPath, id);
    const existingAttachments = existingDetail?.attachments.filter((attachment) => attachment.issue_id === id && attachment.comment_id === null) ?? [];
    const removedSet = new Set(removedIds);
    if (removedSet.size !== removedIds.length || removedIds.some((attachmentId) => !existingAttachments.some((attachment) => attachment.id === attachmentId))) {
      return reply.status(400).send({ success: false, error: "Invalid removed Issue attachments" });
    }
    if (Object.keys(updates).length === 0 && removedIds.length === 0) {
      return reply.status(400).send({ success: false, error: "At least one Issue field is required" });
    }
    const removedAttachments = removedIds.map((attachmentId) => existingAttachments.find((attachment) => attachment.id === attachmentId)!);
    let previousIssueForMentions: Awaited<ReturnType<typeof getIssueById>> = null;
    let contentConflict = false;
    const crossReferenceTargets = new Set<number>();
    try {
      await runDbTransaction(resolved.dbPath, async () => {
        const currentIssue = await getIssueById(resolved.dbPath, id);
        if (!currentIssue) throw new Error("Issue disappeared during update");
        if (expectedUpdatedAt !== undefined && currentIssue.updated_at !== expectedUpdatedAt) {
          contentConflict = true;
          return;
        }
        previousIssueForMentions = currentIssue;
        const editedFields = Object.keys(updates).filter((field) => field !== "status" && field !== "stateReason" && field !== "issueType" && currentIssue[field as keyof typeof currentIssue] !== updates[field as keyof typeof updates]);
        const revisedFields = editedFields.filter((field) => field === "title" || field === "description");
        if (revisedFields.length > 0) {
          await insertIssueRevision(resolved.dbPath, {
            issueId: id, targetType: "issue", targetId: id, editorId: visitorId!,
            title: currentIssue.title, body: currentIssue.description, fields: revisedFields,
          });
        }
        if (Object.keys(updates).length > 0) await updateIssue(resolved.dbPath, id, updates);
        if (revisedFields.includes("description")) {
          const crossReferences = await reconcileIssueCrossReferences(resolved.dbPath, { sourceIssueId: id, sourceType: "issue", sourceId: id, actorId: visitorId!, markdown: updates.description ?? currentIssue.description });
          [...crossReferences.addedTargetIssueIds, ...crossReferences.removedTargetIssueIds].forEach((targetId) => crossReferenceTargets.add(targetId));
        }
        if (revisedFields.length > 0) await replaceIssueMentions(resolved.dbPath, { issueId: id, targetType: "issue", targetId: id, userIds: mentionUserIds });
        if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
          const bound = await bindIssueAttachments(resolved.dbPath, { attachmentIds, draftId: draftId as string, uploaderId: visitorId!, pagePath, issueId: id });
          if (bound.length !== attachmentIds.length) throw new InvalidIssueAttachmentsError();
        }
        if (removedIds.length > 0 && !await deleteBoundIssueAttachments(resolved.dbPath, { attachmentIds: removedIds, issueId: id, commentId: null })) {
          throw new InvalidIssueAttachmentsError();
        }
        if (editedFields.length > 0) {
          await insertIssueEvent(resolved.dbPath, id, visitorId!, "edited", { fields: editedFields });
        }
        if (updates.issueType && updates.issueType !== currentIssue.issue_type) {
          await insertIssueEvent(resolved.dbPath, id, visitorId!, "type_changed", { from: currentIssue.issue_type, to: updates.issueType });
        }
        if (updates.status && updates.status !== currentIssue.status) {
          await insertIssueEvent(resolved.dbPath, id, visitorId!, updates.status === "closed" ? "closed" : "reopened", {
            from: currentIssue.status,
            to: updates.status,
            ...(updates.status === "closed" ? { stateReason: updates.stateReason } : {}),
          });
        }
      });
    } catch (error) {
      if (error instanceof InvalidIssueAttachmentsError) return reply.status(400).send({ success: false, error: "Invalid Issue attachments" });
      throw error;
    }
    if (contentConflict) {
      return reply.status(409).send({ success: false, code: "issue_content_conflict", error: "Issue content changed; latest version required" });
    }
    crossReferenceTargets.forEach((targetId) => publishIssueChanged(pagePath, targetId, "cross-reference:reconciled"));
    for (const attachment of removedAttachments) {
        try { await withAppDataObjectWrite(resolved.pageDir, () => deleteObject(attachment.storage_key)); }
      catch (error) { req.log.warn({ err: error, attachmentId: attachment.id }, "Failed to delete removed Issue attachment object"); }
    }
    const updated = await getIssueById(resolved.dbPath, id);
    try {
      const mentionedRecipients = await notifyIssueMentions({
        dbPath: resolved.dbPath,
        markdown: `${updated!.title}\n\n${updated!.description}`,
        previousMarkdown: `${previousIssueForMentions!.title}\n\n${previousIssueForMentions!.description}`,
        actorId: visitorId,
        appOwner: resolved.userId,
        appName: resolved.name,
        issue: updated!,
      });
      if (issue.status !== updated!.status) {
        await notifyIssueSubscribers({
          dbPath: resolved.dbPath,
          actorId: visitorId,
          appOwner: resolved.userId,
          appName: resolved.name,
          issue: updated!,
          kind: "status_changed",
          status: updated!.status === "closed" ? "closed" : "open",
          stateReason: updated!.state_reason,
          excludeUserIds: mentionedRecipients,
        });
      }
    } catch (notificationError) {
      req.log.error({ err: notificationError, issueId: id }, "Failed to persist Issue mention notifications");
    }
    return { success: true, data: updated };
  });

  app.get<{ Params: { id: string } }>("/api/issues/:id/history", async (req, reply) => {
    const visitorId = host.visitor(req);
    const id = parseNumericId(req.params.id);
    const { pagePath } = req.query as { pagePath?: string };
    if (id === null || !pagePath) return reply.status(400).send({ success: false, error: "Valid issue id and pagePath are required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!await getIssueById(resolved.dbPath, id)) return reply.status(404).send({ success: false, error: "Issue not found" });
    return { success: true, data: await listIssueRevisions(resolved.dbPath, id, "issue", id) };
  });

  app.get<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId/history", async (req, reply) => {
    const visitorId = host.visitor(req);
    const issueId = parseNumericId(req.params.id);
    const commentId = parseNumericId(req.params.commentId);
    const { pagePath } = req.query as { pagePath?: string };
    if (issueId === null || commentId === null || !pagePath) return reply.status(400).send({ success: false, error: "Valid issue, comment, and pagePath are required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const comment = await getIssueComment(resolved.dbPath, commentId);
    if (!comment || comment.issue_id !== issueId || comment.deleted_at) return reply.status(404).send({ success: false, error: "Comment not found" });
    return { success: true, data: await listIssueRevisions(resolved.dbPath, issueId, "comment", commentId) };
  });

  app.delete<{ Params: { id: string; canonicalId: string } }>("/api/issues/:id/duplicate/:canonicalId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const id = parseNumericId(req.params.id);
    const canonicalId = parseNumericId(req.params.canonicalId);
    const body = req.body as { pagePath?: unknown } | null;
    if (id === null || canonicalId === null || !body || typeof body.pagePath !== "string" || Object.keys(body).some((key) => key !== "pagePath")) return reply.status(400).send({ success: false, error: "Invalid duplicate request" });
    const resolved = resolveAppDb(body.pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (resolved.userId !== visitorId) return reply.status(403).send({ success: false, error: "Only the app owner can unmark duplicate Issues" });
    const result = await unmarkIssueDuplicate(resolved.dbPath, id, canonicalId, visitorId);
    if (result !== "removed") return reply.status(404).send({ success: false, error: "Duplicate relation not found" });
    publishIssueChanged(body.pagePath, canonicalId, "duplicate:unmarked");
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, id))!, body.pagePath, visitorId) };
  });

  // POST /api/issues/:id/comments
  app.post<{ Params: { id: string } }>("/api/issues/:id/comments", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) {
      return reply.status(401).send({ success: false, error: "Authentication required" });
    }
    const id = parseNumericId(req.params.id);
    if (id === null) return reply.status(400).send({ success: false, error: "Invalid issue id" });
    const { pagePath, body, statusAction, stateReason, draftId, attachmentIds } = req.body as {
      pagePath?: string;
      body?: unknown;
      statusAction?: unknown;
      stateReason?: unknown;
      draftId?: unknown;
      attachmentIds?: unknown;
    };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath is required" });
    const commentBody = typeof body === "string" ? body.trim() : "";
    const commentAttachmentIds = Array.isArray(attachmentIds) ? attachmentIds.filter((attachmentId): attachmentId is string => typeof attachmentId === "string") : [];
    if (!commentBody && commentAttachmentIds.length === 0) {
      return reply.status(400).send({ success: false, error: "Comment body or attachment is required" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const issue = await getIssueById(resolved.dbPath, id);
    if (!issue) return reply.status(404).send({ success: false, error: "Issue not found" });
    if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || commentAttachmentIds.length !== attachmentIds.length || typeof draftId !== "string" || !draftId)) {
      return reply.status(400).send({ success: false, error: "draftId and attachmentIds are required for attachments" });
    }
    const nextStatus = statusAction === "closed" || statusAction === "close"
      ? "closed"
      : statusAction === "open" || statusAction === "reopen"
        ? "open"
        : undefined;
    if (statusAction !== undefined && !nextStatus) {
      return reply.status(400).send({ success: false, error: "Invalid statusAction" });
    }
    if (stateReason !== undefined && (nextStatus !== "closed" || (stateReason !== "completed" && stateReason !== "not_planned"))) {
      return reply.status(400).send({ success: false, error: "Invalid stateReason" });
    }
    if (nextStatus && nextStatus !== issue.status && issue.reporter_id !== visitorId && resolved.userId !== visitorId) {
      return reply.status(403).send({ success: false, error: "Permission denied" });
    }
    const mentionUserIds = await resolveIssueMentionUserIds(commentBody);
    const duplicateIssueNumber = resolved.userId === visitorId ? parseIssueDuplicateReference(commentBody) : null;
    let createdCommentId: number | undefined;
    const crossReferenceTargets = new Set<number>();
    try {
      await runDbTransaction(resolved.dbPath, async () => {
        const currentIssue = await getIssueById(resolved.dbPath, id);
        if (!currentIssue) throw new Error("Issue disappeared during comment");
        if (currentIssue.locked_at !== null) return;
        const comment = await insertIssueComment(resolved.dbPath, id, commentBody, visitorId!);
        createdCommentId = comment.id;
        const crossReferences = await reconcileIssueCrossReferences(resolved.dbPath, { sourceIssueId: id, sourceType: "comment", sourceId: comment.id, actorId: visitorId!, markdown: commentBody });
        crossReferences.addedTargetIssueIds.forEach((targetId) => crossReferenceTargets.add(targetId));
        if (duplicateIssueNumber !== null) {
          const duplicateResult = await markIssueDuplicateWithComment(resolved.dbPath, { duplicateIssueId: id, canonicalIssueNumber: duplicateIssueNumber, actorId: visitorId!, commentId: comment.id });
          if (duplicateResult !== "created") throw new InvalidIssueDuplicateError(duplicateResult);
        }
        await setIssueSubscription(resolved.dbPath, id, visitorId!, true);
        await replaceIssueMentions(resolved.dbPath, { issueId: id, targetType: "comment", targetId: comment.id, userIds: mentionUserIds });
        if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
          const bound = await bindIssueAttachments(resolved.dbPath, {
            attachmentIds,
            draftId: draftId as string,
            uploaderId: visitorId!,
            issueId: id,
            commentId: comment.id,
            pagePath,
          });
          if (bound.length !== attachmentIds.length) throw new InvalidIssueAttachmentsError();
        }
        if (nextStatus && nextStatus !== currentIssue.status) {
          const nextStateReason = nextStatus === "closed" ? (stateReason === "not_planned" ? "not_planned" : "completed") : null;
          await updateIssue(resolved.dbPath, id, { status: nextStatus, stateReason: nextStateReason });
          await insertIssueEvent(resolved.dbPath, id, visitorId!, nextStatus === "closed" ? "closed" : "reopened", {
            from: currentIssue.status,
            to: nextStatus,
            ...(nextStatus === "closed" ? { stateReason: nextStateReason } : {}),
          });
        }
      });
    } catch (error) {
      if (error instanceof InvalidIssueAttachmentsError) {
        return reply.status(400).send({ success: false, error: "One or more Issue attachments are invalid" });
      }
      if (error instanceof InvalidIssueDuplicateError) {
        if (error.result === "not_found") return reply.status(404).send({ success: false, code: "issue_duplicate_target_not_found", error: "Duplicate target Issue not found" });
        const mapped = ISSUE_DUPLICATE_ERRORS[error.result];
        return reply.status(409).send({ success: false, code: mapped.code, error: mapped.error });
      }
      throw error;
    }
    if (createdCommentId === undefined) {
      return reply.status(409).send({ success: false, code: "issue_locked", error: "This Issue conversation is locked" });
    }
    const detail = await getIssueDetail(resolved.dbPath, id);
    crossReferenceTargets.forEach((targetId) => publishIssueChanged(pagePath, targetId, "cross-reference:added"));
    if (duplicateIssueNumber !== null && detail?.duplicateOf) publishIssueChanged(pagePath, detail.duplicateOf.id, "duplicate:marked");
    try {
      const mentionedRecipients = await notifyIssueMentions({ dbPath: resolved.dbPath, markdown: commentBody, actorId: visitorId, appOwner: resolved.userId, appName: resolved.name, issue, commentId: createdCommentId });
      await notifyIssueSubscribers({
        dbPath: resolved.dbPath,
        actorId: visitorId,
        appOwner: resolved.userId,
        appName: resolved.name,
        issue,
        kind: "commented",
        commentId: createdCommentId,
        excludeUserIds: mentionedRecipients,
      });
    } catch (notificationError) {
      req.log.error({ err: notificationError, issueId: id, commentId: createdCommentId }, "Failed to persist Issue mention notifications");
    }
    return reply.status(201).send({ success: true, data: publicDetail(detail!, pagePath, visitorId) });
  });

  // PATCH /api/issues/:id/comments/:commentId
  app.patch<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const issueId = parseNumericId(req.params.id);
    const commentId = parseNumericId(req.params.commentId);
    if (issueId === null || commentId === null) return reply.status(400).send({ success: false, error: "Invalid issue or comment id" });
    const { pagePath, body, expectedUpdatedAt, draftId, attachmentIds, removedAttachmentIds } = req.body as { pagePath?: string; body?: unknown; expectedUpdatedAt?: unknown; draftId?: unknown; attachmentIds?: unknown; removedAttachmentIds?: unknown };
    const commentBody = typeof body === "string" ? body.trim() : "";
    const editAttachmentIds = Array.isArray(attachmentIds) ? attachmentIds.filter((attachmentId): attachmentId is string => typeof attachmentId === "string") : [];
    const removedIds = Array.isArray(removedAttachmentIds) ? removedAttachmentIds.filter((attachmentId): attachmentId is string => typeof attachmentId === "string") : [];
    if (!pagePath || typeof body !== "string" || (expectedUpdatedAt !== undefined && typeof expectedUpdatedAt !== "string") || (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || editAttachmentIds.length !== attachmentIds.length || typeof draftId !== "string" || !draftId)) || (removedAttachmentIds !== undefined && (!Array.isArray(removedAttachmentIds) || removedIds.length !== removedAttachmentIds.length))) {
      return reply.status(400).send({ success: false, error: "Invalid comment update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const comment = await getIssueComment(resolved.dbPath, commentId);
    if (!comment || comment.issue_id !== issueId || comment.deleted_at) {
      return reply.status(404).send({ success: false, error: "Comment not found" });
    }
    if (comment.author_id !== visitorId) return reply.status(403).send({ success: false, error: "Permission denied" });
    const existingDetail = await getIssueDetail(resolved.dbPath, issueId);
    const existingAttachments = existingDetail?.attachments.filter((attachment) => attachment.comment_id === commentId) ?? [];
    const removedSet = new Set(removedIds);
    if (removedSet.size !== removedIds.length || removedIds.some((attachmentId) => !existingAttachments.some((attachment) => attachment.id === attachmentId))) {
      return reply.status(400).send({ success: false, error: "Invalid removed Issue attachments" });
    }
    const remainingAttachmentCount = existingAttachments.filter((attachment) => !removedSet.has(attachment.id)).length + editAttachmentIds.length;
    if (!commentBody && remainingAttachmentCount === 0) {
      return reply.status(400).send({ success: false, error: "Comment body or attachment is required" });
    }
    const removedAttachments = removedIds.map((attachmentId) => existingAttachments.find((attachment) => attachment.id === attachmentId)!);
    const mentionUserIds = await resolveIssueMentionUserIds(commentBody);
    let contentConflict = false;
    const crossReferenceTargets = new Set<number>();
    if (comment.body !== commentBody || editAttachmentIds.length > 0 || removedIds.length > 0) {
      try {
        await runDbTransaction(resolved.dbPath, async () => {
          const currentComment = await getIssueComment(resolved.dbPath, commentId);
          if (!currentComment || currentComment.issue_id !== issueId || currentComment.deleted_at) throw new Error("Comment disappeared during update");
          if (expectedUpdatedAt !== undefined && currentComment.updated_at !== expectedUpdatedAt) { contentConflict = true; return; }
          if (currentComment.body !== commentBody) {
            await insertIssueRevision(resolved.dbPath, {
              issueId, targetType: "comment", targetId: commentId, editorId: visitorId!, body: currentComment.body, fields: ["body"],
            });
            await updateIssueComment(resolved.dbPath, commentId, commentBody, visitorId!);
            const crossReferences = await reconcileIssueCrossReferences(resolved.dbPath, { sourceIssueId: issueId, sourceType: "comment", sourceId: commentId, actorId: visitorId!, markdown: commentBody });
            [...crossReferences.addedTargetIssueIds, ...crossReferences.removedTargetIssueIds].forEach((targetId) => crossReferenceTargets.add(targetId));
            await replaceIssueMentions(resolved.dbPath, { issueId, targetType: "comment", targetId: commentId, userIds: mentionUserIds });
          }
          if (editAttachmentIds.length > 0) {
            const bound = await bindIssueAttachments(resolved.dbPath, { attachmentIds: editAttachmentIds, draftId: draftId as string, uploaderId: visitorId!, pagePath, issueId, commentId });
            if (bound.length !== editAttachmentIds.length) throw new InvalidIssueAttachmentsError();
          }
          if (removedIds.length > 0 && !await deleteBoundIssueAttachments(resolved.dbPath, { attachmentIds: removedIds, issueId, commentId })) {
            throw new InvalidIssueAttachmentsError();
          }
        });
      } catch (error) {
        if (error instanceof InvalidIssueAttachmentsError) return reply.status(400).send({ success: false, error: "Invalid Issue attachments" });
        throw error;
      }
    }
    if (contentConflict) return reply.status(409).send({ success: false, code: "issue_content_conflict", error: "Issue content changed; latest version required" });
    crossReferenceTargets.forEach((targetId) => publishIssueChanged(pagePath, targetId, "cross-reference:reconciled"));
    for (const attachment of removedAttachments) {
      try { await withAppDataObjectWrite(resolved.pageDir, () => deleteObject(attachment.storage_key)); }
      catch (error) { req.log.warn({ err: error, attachmentId: attachment.id }, "Failed to delete removed Issue attachment object"); }
    }
    const detail = await getIssueDetail(resolved.dbPath, issueId);
    try {
      const issue = detail!.issue;
      await notifyIssueMentions({ dbPath: resolved.dbPath, markdown: commentBody, previousMarkdown: comment.body, actorId: visitorId, appOwner: resolved.userId, appName: resolved.name, issue, commentId });
    } catch (notificationError) {
      req.log.error({ err: notificationError, issueId, commentId }, "Failed to persist Issue mention notifications");
    }
    return { success: true, data: publicDetail(detail!, pagePath, visitorId) };
  });

  app.get<{ Params: { id: string } }>("/api/issues/:id/sub-issues", async (req, reply) => {
    const visitorId = host.visitor(req);
    const parentIssueId = parseNumericId(req.params.id);
    const { pagePath } = req.query as { pagePath?: unknown };
    if (parentIssueId === null || typeof pagePath !== "string") {
      return reply.status(400).send({ success: false, error: "Invalid Sub-issue query" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!await getIssueById(resolved.dbPath, parentIssueId)) return reply.status(404).send({ success: false, error: "Issue not found" });
    return { success: true, data: await listIssueSubIssues(resolved.dbPath, parentIssueId) };
  });

  app.put<{ Params: { id: string; childId: string } }>("/api/issues/:id/sub-issues/:childId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const parentIssueId = parseNumericId(req.params.id);
    const childIssueId = parseNumericId(req.params.childId);
    const { pagePath } = req.body as { pagePath?: unknown };
    if (parentIssueId === null || childIssueId === null || typeof pagePath !== "string") {
      return reply.status(400).send({ success: false, error: "Invalid Sub-issue update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Sub-issues" });
    const result = await addIssueSubIssue(resolved.dbPath, parentIssueId, childIssueId, visitorId);
    if (result === "not_found") return reply.status(404).send({ success: false, error: "Issue not found" });
    if (result !== "added") return reply.status(409).send({ success: false, ...ISSUE_SUB_ISSUE_ERRORS[result] });
    const detail = await getIssueDetail(resolved.dbPath, parentIssueId);
    return { success: true, data: publicDetail(detail!, pagePath, visitorId) };
  });

  app.delete<{ Params: { id: string; childId: string } }>("/api/issues/:id/sub-issues/:childId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const parentIssueId = parseNumericId(req.params.id);
    const childIssueId = parseNumericId(req.params.childId);
    const { pagePath } = req.body as { pagePath?: unknown };
    if (parentIssueId === null || childIssueId === null || typeof pagePath !== "string") {
      return reply.status(400).send({ success: false, error: "Invalid Sub-issue removal" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Sub-issues" });
    if (await removeIssueSubIssue(resolved.dbPath, parentIssueId, childIssueId, visitorId) === "not_found") {
      return reply.status(404).send({ success: false, error: "Sub-issue relationship not found" });
    }
    const detail = await getIssueDetail(resolved.dbPath, parentIssueId);
    return { success: true, data: publicDetail(detail!, pagePath, visitorId) };
  });

  app.patch<{ Params: { id: string } }>("/api/issues/:id/sub-issues/priority", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const parentIssueId = parseNumericId(req.params.id);
    const { pagePath, childIssueId, afterIssueId } = req.body as { pagePath?: unknown; childIssueId?: unknown; afterIssueId?: unknown };
    if (parentIssueId === null || typeof pagePath !== "string" || !Number.isSafeInteger(childIssueId) || Number(childIssueId) < 1 || (afterIssueId !== null && (!Number.isSafeInteger(afterIssueId) || Number(afterIssueId) < 1))) {
      return reply.status(400).send({ success: false, error: "Invalid Sub-issue priority update", code: "invalid_sub_issue_priority" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Sub-issues" });
    const result = await reprioritizeIssueSubIssue(resolved.dbPath, parentIssueId, Number(childIssueId), afterIssueId === null ? null : Number(afterIssueId), visitorId);
    if (result === "self_after") return reply.status(400).send({ success: false, error: "A Sub-issue cannot be positioned after itself", code: "sub_issue_self_after" });
    if (result === "parent_not_found") return reply.status(404).send({ success: false, error: "Parent Issue not found", code: "parent_issue_not_found" });
    if (result === "child_not_found") return reply.status(409).send({ success: false, error: "Sub-issue relationship changed", code: "sub_issue_not_found" });
    if (result === "after_not_found") return reply.status(409).send({ success: false, error: "Target Sub-issue relationship changed", code: "sub_issue_after_not_found" });
    const detail = await getIssueDetail(resolved.dbPath, parentIssueId);
    return { success: true, data: publicDetail(detail!, pagePath, visitorId), unchanged: result === "unchanged" };
  });

  app.post<{ Params: { id: string; taskIndex: string } }>("/api/issues/:id/tasks/:taskIndex/convert", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const parentIssueId = parseNumericId(req.params.id);
    const taskIndex = /^\d+$/.test(req.params.taskIndex) ? Number(req.params.taskIndex) : -1;
    const { pagePath, expectedUpdatedAt, title } = req.body as { pagePath?: unknown; expectedUpdatedAt?: unknown; title?: unknown };
    if (parentIssueId === null || !Number.isSafeInteger(taskIndex) || taskIndex < 0 || typeof pagePath !== "string" || typeof expectedUpdatedAt !== "string" || (title !== undefined && typeof title !== "string")) {
      return reply.status(400).send({ success: false, error: "Invalid Issue task conversion" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can convert Issue tasks" });

    const result = await convertIssueTaskToSubIssue(resolved.dbPath, {
      parentIssueId,
      taskIndex,
      expectedUpdatedAt,
      actorId: visitorId,
      ...(title === undefined ? {} : { title }),
      resolveMentionUserIds: resolveIssueMentionUserIds,
    });
    if (result.status === "not_found" || result.status === "task_not_found") {
      return reply.status(404).send({ success: false, code: result.status === "task_not_found" ? "issue_task_not_found" : "issue_not_found", error: result.status === "task_not_found" ? "Issue task not found" : "Issue not found" });
    }
    if (result.status === "content_conflict") return reply.status(409).send({ success: false, code: "issue_content_conflict", error: "Issue content changed. Refresh and try again." });
    if (result.status === "task_not_convertible") return reply.status(409).send({ success: false, code: "issue_task_not_convertible", error: "This task cannot be converted" });
    if (result.status === "title_invalid") return reply.status(400).send({ success: false, code: "issue_title_invalid", error: "Issue title must contain 1 to 256 characters" });
    if (result.status === "relation_conflict") return reply.status(409).send({ success: false, ...ISSUE_SUB_ISSUE_ERRORS[result.reason] });
    if (result.status !== "converted") throw new Error(`Unhandled Issue task conversion result: ${result.status}`);

    publishIssueChanged(pagePath, parentIssueId, "task:converted");
    publishIssueChanged(pagePath, result.childIssueId, "created");
    [...result.addedTargetIssueIds, ...result.removedTargetIssueIds].forEach((targetId) => publishIssueChanged(pagePath, targetId, "cross-reference:reconciled"));
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, parentIssueId))!, pagePath, visitorId) };
  });

  app.put<{ Params: { id: string; blockerId: string } }>("/api/issues/:id/dependencies/blocked-by/:blockerId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const blockedIssueId = parseNumericId(req.params.id);
    const blockingIssueId = parseNumericId(req.params.blockerId);
    const { pagePath } = req.body as { pagePath?: unknown };
    if (blockedIssueId === null || blockingIssueId === null || typeof pagePath !== "string") {
      return reply.status(400).send({ success: false, error: "Invalid Issue dependency update" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue dependencies" });
    const result = await addIssueDependency(resolved.dbPath, blockedIssueId, blockingIssueId, visitorId);
    if (result === "not_found") return reply.status(404).send({ success: false, error: "Issue not found" });
    if (result !== "added") return reply.status(409).send({ success: false, ...ISSUE_DEPENDENCY_ERRORS[result] });
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, blockedIssueId))!, pagePath, visitorId) };
  });

  app.delete<{ Params: { id: string; blockerId: string } }>("/api/issues/:id/dependencies/blocked-by/:blockerId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const blockedIssueId = parseNumericId(req.params.id);
    const blockingIssueId = parseNumericId(req.params.blockerId);
    const { pagePath } = req.body as { pagePath?: unknown };
    if (blockedIssueId === null || blockingIssueId === null || typeof pagePath !== "string") {
      return reply.status(400).send({ success: false, error: "Invalid Issue dependency removal" });
    }
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    if (!isOwner(resolved, visitorId)) return reply.status(403).send({ success: false, error: "Only the app owner can manage Issue dependencies" });
    if (await removeIssueDependency(resolved.dbPath, blockedIssueId, blockingIssueId, visitorId) === "not_found") {
      return reply.status(404).send({ success: false, error: "Issue dependency not found" });
    }
    return { success: true, data: publicDetail((await getIssueDetail(resolved.dbPath, blockedIssueId))!, pagePath, visitorId) };
  });

  // DELETE /api/issues/:id/comments/:commentId?pagePath=...
  app.delete<{ Params: { id: string; commentId: string } }>("/api/issues/:id/comments/:commentId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const issueId = parseNumericId(req.params.id);
    const commentId = parseNumericId(req.params.commentId);
    if (issueId === null || commentId === null) return reply.status(400).send({ success: false, error: "Invalid issue or comment id" });
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const comment = await getIssueComment(resolved.dbPath, commentId);
    if (!comment || comment.issue_id !== issueId || comment.deleted_at) {
      return reply.status(404).send({ success: false, error: "Comment not found" });
    }
    if (comment.author_id !== visitorId) return reply.status(403).send({ success: false, error: "Permission denied" });
    const crossReferenceTargets = new Set<number>();
    await runDbTransaction(resolved.dbPath, async () => {
      const crossReferences = await reconcileIssueCrossReferences(resolved.dbPath, { sourceIssueId: issueId, sourceType: "comment", sourceId: commentId, actorId: visitorId!, markdown: "" });
      crossReferences.removedTargetIssueIds.forEach((targetId) => crossReferenceTargets.add(targetId));
      await deleteIssueComment(resolved.dbPath, commentId, visitorId!);
    });
    crossReferenceTargets.forEach((targetId) => publishIssueChanged(pagePath, targetId, "cross-reference:removed"));
    const detail = await getIssueDetail(resolved.dbPath, issueId);
    return { success: true, data: publicDetail(detail!, pagePath, visitorId) };
  });

  // POST /api/issues/attachments
  app.post("/api/issues/attachments", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    let upload;
    try {
      upload = await req.file({ limits: { fileSize: MAX_ISSUE_ATTACHMENT_BYTES } });
    } catch {
      return reply.status(400).send({ success: false, error: "Invalid multipart attachment" });
    }
    if (!upload) return reply.status(400).send({ success: false, error: "Attachment file is required" });
    const fields = upload.fields as Record<string, { value?: unknown }>;
    const pagePath = typeof fields.pagePath?.value === "string" ? fields.pagePath.value : undefined;
    const draftId = typeof fields.draftId?.value === "string" ? fields.draftId.value : undefined;
    if (!pagePath || !draftId) return reply.status(400).send({ success: false, error: "pagePath and draftId are required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    const expired = await listExpiredUnboundIssueAttachments(
      resolved.dbPath,
      new Date(Date.now() - ISSUE_DRAFT_TTL_MS).toISOString(),
    );
    for (const attachment of expired) {
      try {
        await runDbTransaction(resolved.dbPath, async () => {
          await withAppDataObjectWrite(resolved.pageDir, () => deleteObject(attachment.storage_key));
          await deleteIssueAttachmentMetadata(resolved.dbPath, attachment.id);
        });
      } catch (error) {
        req.log.warn({ err: error, attachmentId: attachment.id }, "Failed to clean expired Issue attachment draft");
      }
    }
    let bytes: Buffer;
    try {
      bytes = await upload.toBuffer();
    } catch {
      return reply.status(413).send({ success: false, error: "Attachment exceeds 25 MiB limit" });
    }
    if (upload.file.truncated || bytes.length > MAX_ISSUE_ATTACHMENT_BYTES) {
      return reply.status(413).send({ success: false, error: "Attachment exceeds 25 MiB limit" });
    }
    if (bytes.length === 0) return reply.status(400).send({ success: false, error: "Attachment file is empty" });
    const id = randomUUID();
    const mimeType = normalizeIssueAttachmentMimeType(upload.mimetype);
    const storageKey = `issues/${resolved.userId}/${resolved.name}/${id}/content`;
    let attachment;
    try {
      attachment = await runDbTransaction(resolved.dbPath, async () => {
        await withAppDataObjectWrite(resolved.pageDir, () => putObject(storageKey, bytes, mimeType));
        try {
          return insertIssueAttachment(resolved.dbPath, {
            id,
            pagePath,
            draftId,
            uploaderId: visitorId!,
            storageKey,
            fileName: sanitizeIssueAttachmentFileName(upload.filename),
            mimeType,
            sizeBytes: bytes.length,
          });
        } catch (error) {
          await Promise.resolve(deleteObject(storageKey)).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      await Promise.resolve(deleteObject(storageKey)).catch(() => undefined);
      if (typeof error === "object" && error !== null && "name" in error && error.name === "IssueAttachmentDraftLimitError") {
        return reply.status(409).send({
          success: false,
          code: "attachment_limit_exceeded",
          error: "每个草稿最多添加 20 个附件",
        });
      }
      throw error;
    }
    return reply.status(201).send({
      success: true,
      data: { ...publicAttachment(attachment), url: issueAttachmentUrl(pagePath, attachment.id) },
    });
  });

  // DELETE /api/issues/attachments/:attachmentId?pagePath=...&draftId=...
  app.delete<{ Params: { attachmentId: string } }>("/api/issues/attachments/:attachmentId", async (req, reply) => {
    const visitorId = host.visitor(req);
    if (!visitorId) return reply.status(401).send({ success: false, error: "Authentication required" });
    const { pagePath, draftId } = req.query as { pagePath?: string; draftId?: string };
    if (!pagePath || !draftId) return reply.status(400).send({ success: false, error: "pagePath and draftId query parameters are required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId)) return;
    try {
      const attachment = await runDbTransaction(resolved.dbPath, async () => {
        const released = await releaseUnboundIssueAttachment(resolved.dbPath, {
          attachmentId: req.params.attachmentId,
          pagePath,
          draftId,
          uploaderId: visitorId!,
        });
        if (!released) return null;
        await withAppDataObjectWrite(resolved.pageDir, () => deleteObject(released.storage_key));
        return released;
      });
      if (!attachment) return reply.status(404).send({ success: false, error: "Attachment not found" });
    } catch (error) {
      req.log.warn({ err: error, attachmentId: req.params.attachmentId }, "Failed to delete discarded Issue attachment object");
      return reply.status(503).send({ success: false, error: "Attachment cleanup temporarily unavailable" });
    }
    return { success: true };
  });

  // GET /api/issues/attachments/:attachmentId?pagePath=...
  app.get<{ Params: { attachmentId: string } }>("/api/issues/attachments/:attachmentId", async (req, reply) => {
    const visitorId = host.visitor(req);
    const { pagePath } = req.query as { pagePath?: string };
    if (!pagePath) return reply.status(400).send({ success: false, error: "pagePath query parameter is required" });
    const resolved = resolveAppDb(pagePath);
    if (!resolved) return reply.status(404).send({ success: false, error: "Application not found" });
    if (!ensureAppAccess(reply, resolved, visitorId, 403)) return;
    const attachment = await getIssueAttachment(resolved.dbPath, req.params.attachmentId);
    if (!attachment || attachment.page_path !== pagePath) return reply.status(404).send({ success: false, error: "Attachment not found" });
    if (attachment.issue_id === null && attachment.uploader_id !== visitorId) {
      return reply.status(404).send({ success: false, error: "Attachment not found" });
    }
    const object = await getObject(attachment.storage_key);
    if (!object) return reply.status(404).send({ success: false, error: "Attachment content not found" });
    const mimeType = normalizeIssueAttachmentMimeType(attachment.mime_type);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Disposition", issueAttachmentContentDisposition(attachment.file_name, isInlineIssueAttachment(mimeType)));
    return reply.type(mimeType).send(object.body);
  });
}
