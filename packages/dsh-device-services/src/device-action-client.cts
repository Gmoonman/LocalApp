import {
  DEVICE_ACTION_PROTOCOL_VERSION,
  normalizeDeviceActionOrigin,
  type DeviceActionStatus,
  type DeviceActivationTicket,
} from "@localapp/dsh-device-services/device-action-types";
import { parseDeviceActivationTicket } from "@localapp/dsh-device-services/device-action-ticket";
import type { DeviceActionRecord } from "@localapp/dsh-device-services/device-action-record";

export interface DeviceActionClientOptions {
  installationId: string;
  fetch?: typeof fetch;
  allowPrivateHttp?: boolean;
  timeoutMs?: number;
}

export interface ClaimedDeviceAction {
  action: DeviceActionRecord;
  callbackToken: string;
  installationId: string;
}

export class DeviceActionClientError extends Error {
  constructor(public readonly code: string, message = code, public readonly status = 0) {
    super(message);
    this.name = "DeviceActionClientError";
  }
}

export class DeviceActionClient {
  private readonly fetcher: typeof fetch;
  private readonly allowPrivateHttp: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly options: DeviceActionClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis) as typeof fetch;
    this.allowPrivateHttp = options.allowPrivateHttp ?? false;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!this.fetcher) throw new DeviceActionClientError("DEVICE_ACTION_FETCH_UNAVAILABLE");
  }

  async claim(ticket: DeviceActivationTicket): Promise<ClaimedDeviceAction> {
    const canonical = parseDeviceActivationTicket(ticket);
    const body = await this.request(canonical.sourceOrigin, `/api/device-actions/${canonical.actionId}/claim`, {
      method: "POST",
      body: JSON.stringify({ ...canonical, installationId: this.options.installationId }),
    });
    const data = unwrapData(body);
    if (!isRecord(data) || !isRecord(data.action) || typeof data.callbackToken !== "string") {
      throw new DeviceActionClientError("DEVICE_ACTION_INVALID_RESPONSE");
    }
    return {
      action: data.action as DeviceActionRecord,
      callbackToken: data.callbackToken,
      installationId: this.options.installationId,
    };
  }

  async update(
    sourceOrigin: string,
    requestId: string,
    callbackToken: string,
    status: DeviceActionStatus,
    result?: unknown,
    error?: { message: string; code?: string } | null,
  ): Promise<unknown> {
    const origin = normalizeDeviceActionOrigin(sourceOrigin);
    return unwrapData(await this.request(origin, `/api/device-actions/${requestId}/status`, {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: DEVICE_ACTION_PROTOCOL_VERSION,
        installationId: this.options.installationId,
        callbackToken,
        status,
        ...(result === undefined ? {} : { result }),
        ...(error === undefined ? {} : { error }),
      }),
    }));
  }

  async cancel(sourceOrigin: string, requestId: string, callbackToken: string): Promise<unknown> {
    return this.update(sourceOrigin, requestId, callbackToken, "cancelled");
  }

  private async request(origin: string, requestPath: string, init: { method: string; body: string }): Promise<unknown> {
    const url = new URL(requestPath, `${normalizeDeviceActionOrigin(origin)}/`);
    if (!isAllowedRemoteOrigin(url, this.allowPrivateHttp)) {
      throw new DeviceActionClientError("DEVICE_ACTION_REMOTE_ORIGIN_DENIED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!response.ok || (isRecord(body) && body.success === false)) {
        throw new DeviceActionClientError(
          isRecord(body) && typeof body.code === "string" ? body.code : "DEVICE_ACTION_REMOTE_REQUEST_FAILED",
          isRecord(body) && typeof body.error === "string" ? body.error : `Remote Server returned HTTP ${response.status}`,
          response.status,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof DeviceActionClientError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new DeviceActionClientError("DEVICE_ACTION_REMOTE_TIMEOUT");
      throw new DeviceActionClientError("DEVICE_ACTION_REMOTE_UNREACHABLE", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAllowedRemoteOrigin(url: URL, allowPrivateHttp: boolean): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  if (loopback) return true;
  if (!allowPrivateHttp) return false;
  return hostname.startsWith("10.") || hostname.startsWith("192.168.") || hostname.startsWith("172.16.");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && value.success === true && "data" in value ? value.data : value;
}
