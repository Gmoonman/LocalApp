import type { WebSocket } from "ws";

/**
 * WebSocket 消息总线信封。
 *
 * type 命名空间约定：
 * - `bus:*` — 连接生命周期（bus:ready / bus:pong）
 * - `notify:*` — 通知事件（notify:notification / notify:missed）
 */
export interface WsMessage {
  type: string;
  data?: unknown;
}

export const DESKTOP_ACTION_PROTOCOL_VERSION = 1;
export const NOTIFICATION_DELIVERY_PROTOCOL_VERSION = 2;

export interface WsConnectionMetadata {
  clientKind: "desktop" | "notification-daemon" | "generic";
  protocolVersion?: number;
  notificationProtocolVersion?: number;
  installationId?: string;
}

/**
 * 进程级 WS 连接池。每个 user 可有多设备并发连接，并为每条连接保留客户端元数据。
 *
 * 提供广播 API：notify 端点持久化后调用 sendToUser(userId, msg)，
 * 由本管理器将消息推送到该 user 的全部活跃连接。
 *
 * 单实例 server 设计；多实例需替换为 Redis Pub/Sub。
 */
export class WsManager {
  private connections = new Map<string, Map<WebSocket, WsConnectionMetadata>>();

  add(
    userId: string,
    socket: WebSocket,
    metadata: WsConnectionMetadata = { clientKind: "generic" },
  ): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Map();
      this.connections.set(userId, set);
    }
    set.set(socket, metadata);
  }

  remove(userId: string, socket: WebSocket): void {
    const set = this.connections.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.connections.delete(userId);
    }
  }

  /**
   * 推送给某 user 的所有活跃连接。返回成功推送的连接数。
   */
  sendToUser(userId: string, message: WsMessage): number {
    const set = this.connections.get(userId);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const socket of set.keys()) {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.send(payload);
          sent++;
        } catch {
          // One broken connection must not prevent durable delivery to peers.
        }
      }
    }
    return sent;
  }

  /**
   * 仅向达到最低协议版本的 Desktop 连接发布动作请求。
   */
  sendToDesktopUser(
    userId: string,
    data: unknown,
    minimumProtocolVersion = DESKTOP_ACTION_PROTOCOL_VERSION,
  ): number {
    const set = this.connections.get(userId);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify({ type: "desktop:action-requested", data } satisfies WsMessage);
    let sent = 0;
    for (const [socket, metadata] of set) {
      if (
        socket.readyState === socket.OPEN
        && this.meetsDesktopProtocol(metadata, minimumProtocolVersion)
      ) {
        try {
          socket.send(payload);
          sent++;
        } catch {
          // Isolate individual Desktop transports just like notification sockets.
        }
      }
    }
    return sent;
  }

  /**
   * 返回在线且达到最低协议版本的 Desktop 连接数。
   */
  getDesktopConnectionCount(
    userId: string,
    minimumProtocolVersion = DESKTOP_ACTION_PROTOCOL_VERSION,
  ): number {
    const set = this.connections.get(userId);
    if (!set || set.size === 0) return 0;
    let count = 0;
    for (const [socket, metadata] of set) {
      if (
        socket.readyState === socket.OPEN
        && this.meetsDesktopProtocol(metadata, minimumProtocolVersion)
      ) {
        count++;
      }
    }
    return count;
  }

  hasDesktopCapability(
    userId: string,
    minimumProtocolVersion = DESKTOP_ACTION_PROTOCOL_VERSION,
  ): boolean {
    return this.getDesktopConnectionCount(userId, minimumProtocolVersion) > 0;
  }

  /**
   * 测试/诊断：返回某 user 的当前连接数。
   */
  getConnectionCount(userId: string): number {
    return this.connections.get(userId)?.size ?? 0;
  }

  /**
   * 测试/诊断：返回所有 user 的连接数。
   */
  totalConnections(): number {
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }

  closeAll(): void {
    const sockets = [...this.connections.values()].flatMap(connections => [...connections.keys()]);
    this.connections.clear();
    for (const socket of sockets) {
      try { socket.close(1001, "Platform plugin stopped"); }
      catch { try { socket.terminate(); } catch { /* continue closing other clients */ } }
    }
  }

  private meetsDesktopProtocol(
    metadata: WsConnectionMetadata,
    minimumProtocolVersion: number,
  ): boolean {
    return metadata.clientKind === "desktop"
      && typeof metadata.protocolVersion === "number"
      && Number.isInteger(metadata.protocolVersion)
      && metadata.protocolVersion >= minimumProtocolVersion;
  }
}

export const wsManager = new WsManager();
