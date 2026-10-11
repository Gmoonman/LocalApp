import { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import {
  DESKTOP_ACTION_PROTOCOL_VERSION,
  NOTIFICATION_DELIVERY_PROTOCOL_VERSION,
  type WsManager,
  type WsConnectionMetadata,
  type WsMessage,
} from "./ws-manager.cjs";

export const MAX_WS_INSTALLATION_ID_LENGTH = 128;

export function parseWsConnectionMetadata(query: unknown): WsConnectionMetadata {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return { clientKind: "generic" };
  }

  const values = query as Record<string, unknown>;
  if (values.client === "notification-daemon") {
    if (values.notificationProtocolVersion === String(NOTIFICATION_DELIVERY_PROTOCOL_VERSION)) {
      return {
        clientKind: "notification-daemon",
        notificationProtocolVersion: NOTIFICATION_DELIVERY_PROTOCOL_VERSION,
      };
    }
    return { clientKind: "generic" };
  }
  if (values.client !== "desktop") {
    return { clientKind: "generic" };
  }

  const metadata: WsConnectionMetadata = { clientKind: "desktop" };
  if (values.protocolVersion === String(DESKTOP_ACTION_PROTOCOL_VERSION)) {
    metadata.protocolVersion = DESKTOP_ACTION_PROTOCOL_VERSION;
  }
  if (
    typeof values.installationId === "string"
    && values.installationId.trim().length > 0
    && values.installationId.length <= MAX_WS_INSTALLATION_ID_LENGTH
  ) {
    metadata.installationId = values.installationId;
  }
  return metadata;
}

export function buildWsReadyMessage(
  userId: string,
  metadata: WsConnectionMetadata,
  latestSequence: number,
): WsMessage {
  if (
    metadata.clientKind === "notification-daemon"
    && metadata.notificationProtocolVersion === NOTIFICATION_DELIVERY_PROTOCOL_VERSION
  ) {
    return {
      type: "bus:ready",
      data: {
        userId,
        notificationProtocolVersion: NOTIFICATION_DELIVERY_PROTOCOL_VERSION,
        latestSequence,
      },
    };
  }
  return { type: "bus:ready", data: { userId } };
}

export function shouldSendLegacyMissed(metadata: WsConnectionMetadata): boolean {
  return !(
    metadata.clientKind === "notification-daemon"
    && metadata.notificationProtocolVersion === NOTIFICATION_DELIVERY_PROTOCOL_VERSION
  );
}

/**
 * GET /api/ws — WebSocket 系统消息总线。
 *
 * 鉴权：Authorization: Bearer <api_key>（仅 daemon 客户端）
 * 浏览器/Shell 不直接连接 /api/ws，通过 HTTP /api/inbox* 轮询。
 *
 * 建链后流程：
 * 1. 服务端发送 bus:ready
 * 2. 客户端每 30s 内发 ping，服务端回 pong（保活）
 * 3. 服务端通过本连接推送 notify:notification / notify:missed
 */
export interface WebSocketRoutesHost {
  connections: WsManager;
  keyOwner(key: string): string | null;
  unread(userId: string, limit: number): unknown[];
  highWater(): number;
}
export async function registerWebSocket(app: FastifyInstance, host: WebSocketRoutesHost) {
  const { connections: wsManager, keyOwner: validateApiKey, unread: getUnreadInboxItems, highWater: getNotificationDeliveryHighWater } = host;
  app.get("/api/ws", { websocket: true }, (connection: SocketStream, req) => {
    const socket = connection.socket;
    try {
      const auth = req.headers.authorization as string | undefined;
      app.log.info({ hasAuth: !!auth }, "WS connection accepted");
      if (!auth || !auth.startsWith("Bearer ")) {
        socket.close(4401, "Authorization required");
        return;
      }
      const apiKey = auth.slice(7);
      const userId = validateApiKey(apiKey);
      app.log.info({ userId: !!userId }, "WS api key validation result");
      if (!userId) {
        socket.close(4401, "Invalid API key");
        return;
      }

      const metadata = parseWsConnectionMetadata(req.query);
      wsManager.add(userId, socket, metadata);

      socket.send(JSON.stringify(buildWsReadyMessage(
        userId,
        metadata,
        getNotificationDeliveryHighWater(),
      )));

      // 建链后推送未读通知摘要（仅 count；daemon 收到后调 inbox API 拉取详情）
      if (shouldSendLegacyMissed(metadata)) {
        const missed = getUnreadInboxItems(userId, 50);
        if (missed.length > 0) {
          socket.send(JSON.stringify({ type: "notify:missed", data: { count: missed.length } } satisfies WsMessage));
        }
      }

      socket.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WsMessage;
          if (msg.type === "bus:ping") {
            socket.send(JSON.stringify({ type: "bus:pong", data: { t: Date.now() } } satisfies WsMessage));
          }
        } catch {
          // 忽略无法解析的消息
        }
      });

      socket.on("close", () => {
        wsManager.remove(userId, socket);
      });
    } catch (err: any) {
      app.log.error({ err }, "WS handler error");
      try { socket.close(4500, "Internal error"); } catch { /* ignore */ }
    }
  });
}
