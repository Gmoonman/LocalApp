import type { FastifyRequest, FastifyReply } from "fastify";
import type { PageMeta } from "@localapp/app-foundation/page-storage";
import { getPageDir } from "@localapp/app-foundation/page-storage";
import { checkNotifyPermission } from "@localapp/app-foundation/access-control";
import { getNotifyRateLimiter } from "@localapp/dsh-device-services/notify-rate-limit";
import { validateReferer } from "@localapp/dsh-device-services/notify-referer";
import { validateNotifyPayload, type NotifyPayload } from "@localapp/dsh-device-services/notify-payload";

export type ApplicationNotificationRecord = Omit<NotifyPayload, "to"> & {
  id: string; userId: string; appOwner: string; appName: string;
};
export interface ApplicationNotificationHost {
  dataDir(request: FastifyRequest): string;
  visitorId(request: FastifyRequest): string | null | undefined;
  resolveRecipients(owner: string, name: string, to: NotifyPayload["to"]): string[];
  persistNotifications(records: ApplicationNotificationRecord[]): Array<{ id: string }>;
}

export async function handleApplicationNotification(
  req: FastifyRequest, reply: FastifyReply, meta: PageMeta,
  userId: string, pageName: string, host: ApplicationNotificationHost,
) {
          const rateLimit = getNotifyRateLimiter().check(`${userId}/${pageName}`);
          if (!rateLimit.allowed) {
            reply.header("Retry-After", String(rateLimit.retryAfterSec));
            return reply.status(429).send({ success: false, error: "Rate limit exceeded. Try again later." });
          }
          const refererError = validateReferer(
            req.headers.referer as string | undefined,
            req.hostname,
            userId,
            pageName,
          );
          if (refererError) {
            return reply.status(403).send({ success: false, error: refererError });
          }
          const perm = await checkNotifyPermission(
            host.visitorId(req),
            meta.userId,
            getPageDir(host.dataDir(req), userId, pageName),
            meta.notify?.permission,
          );
          if (perm.status !== 200) {
            return reply.status(perm.status).send({ success: false, error: perm.error });
          }
          const payloadResult = validateNotifyPayload(req.body);
          if (!payloadResult.ok) {
            return reply.status(400).send({ success: false, error: payloadResult.error });
          }
          const payload = payloadResult.payload;
          const recipients = host.resolveRecipients(userId, pageName, payload.to);
          const records = recipients.map((uid) => ({
            id: "",
            userId: uid,
            appOwner: userId,
            appName: pageName,
            title: payload.title,
            body: payload.body,
            url: payload.url,
            priority: payload.priority,
            data: payload.data,
          }));
          const persisted = host.persistNotifications(records);
          return {
            success: true,
            delivered: persisted.length,
            ids: persisted.map((p) => p.id),
          };
}
