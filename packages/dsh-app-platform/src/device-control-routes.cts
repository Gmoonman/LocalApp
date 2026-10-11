import crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DeviceActionClient } from "./device-action-client.cjs";
import { DeviceActionExecutionError, type ExecuteDeviceActionInput } from "./device-action-executor.cjs";
import { DeviceActionLocalStore, type LocalDeviceActionRecord } from "./device-action-local-store.cjs";
import {
  canonicalizeDeviceActionPermissions,
  DEVICE_ACTION_PROTOCOL_VERSION,
  type DeviceActionStatus,
} from "./device-action-types.cjs";
import { parseDeviceActivationTicket } from "./device-action-ticket.cjs";
import { DeviceActionTrustStore } from "./device-action-trust-store.cjs";



export interface DeviceControlHost {
  config: { dataDir: string; workspaceDir: string; publicUrl?: string; listenHost: string; listenPort: number; allowInsecureLan: boolean; deviceControlToken?: string };
  requireUser(request: FastifyRequest, reply: FastifyReply): string | null;
  userRole(userId: string): string | null;
  execute(input: ExecuteDeviceActionInput): Promise<unknown>;
}
export async function registerDeviceControl(app: FastifyInstance, host: DeviceControlHost) {
  const executeDeviceAction = host.execute;
  const requireRequestUser = host.requireUser;
  const getUserRole = host.userRole;
const TOKEN_HEADER = "x-localapp-device-control";
const ACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(reply: FastifyReply, status: number, code: string, message = code) {
  return reply.status(status).send({ success: false, code, error: message });
}

function localOrigin(req: FastifyRequest): string {
  const config = host.config;
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  const address = req.server.server.address();
  const port = address && typeof address !== "string" ? address.port : config.listenPort;
  const listenHost = config.listenHost === "0.0.0.0" || config.listenHost === "::" ? "127.0.0.1" : config.listenHost;
  return `http://${listenHost}:${port}`;
}

function isLoopback(req: FastifyRequest): boolean {
  const address = req.socket.remoteAddress ?? req.ip;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasControlToken(req: FastifyRequest, expected: string): boolean {
  const supplied = req.headers[TOKEN_HEADER];
  if (typeof supplied !== "string" || supplied.length === 0 || expected.length === 0) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireLocalAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = requireRequestUser(req, reply);
  if (!userId) return null;
  if (getUserRole(userId) !== "admin") {
    error(reply, 403, "DEVICE_ACTION_LOCAL_ADMIN_REQUIRED", "Local administrator required");
    return null;
  }
  return userId;
}

  const store = new DeviceActionLocalStore(host.config.dataDir);
  const trust = new DeviceActionTrustStore({ dataDir: host.config.dataDir });
  const client = new DeviceActionClient({
    installationId: store.installationId(),
    allowPrivateHttp: host.config.allowInsecureLan,
  });

  const controlToken = host.config.deviceControlToken ?? "";
  if (controlToken) {
    app.post("/api/device-control/activations", { bodyLimit: 32 * 1024 }, async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isLoopback(req)) return error(reply, 403, "DEVICE_ACTION_LOOPBACK_REQUIRED");
      if (!hasControlToken(req, controlToken)) return error(reply, 401, "DEVICE_ACTION_CONTROL_TOKEN_INVALID");
      if (!isRecord(req.body) || Object.keys(req.body).some((key) => !["protocolVersion", "sourceOrigin", "actionId", "nonce"].includes(key))) {
        return error(reply, 400, "DEVICE_ACTION_INVALID_TICKET");
      }
      let ticket;
      try { ticket = parseDeviceActivationTicket(req.body); } catch { return error(reply, 400, "DEVICE_ACTION_INVALID_TICKET"); }
      try {
        const claimed = await client.claim(ticket);
        const local = store.claim(claimed.action, claimed.callbackToken);
        const identity = identityFrom(local);
        const existingTrust = trust.find(identity, local.permissions);
        if (local.status === "claimed") {
          if (existingTrust) {
            store.transition(local.requestId, "preparing");
            void runAction(store, client, local.requestId, host.config.workspaceDir, host.config.dataDir);
          } else {
            store.transition(local.requestId, "awaiting_trust");
          }
        }
        return {
          success: true,
          data: {
            requestId: local.requestId,
            status: store.get(local.requestId)?.status ?? local.status,
            confirmationUrl: `${localOrigin(req)}/my/device-actions/?requestId=${encodeURIComponent(local.requestId)}`,
            protocolVersion: DEVICE_ACTION_PROTOCOL_VERSION,
          },
        };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        const code = message.startsWith("DEVICE_ACTION_") ? message : "DEVICE_ACTION_ACTIVATION_FAILED";
        return error(reply, code === "DEVICE_ACTION_CLAIM_CONFLICT" ? 409 : 502, code, "Device action activation failed");
      }
    });
  }

  app.get("/api/device-actions/local", async (req, reply) => {
    if (!requireLocalAdmin(req, reply)) return;
    reply.header("Cache-Control", "no-store");
    return { success: true, data: { actions: store.list(), trusts: trust.list(), installationId: store.installationId() } };
  });

  app.get<{ Params: { id: string } }>("/api/device-actions/local/:id/logs", async (req, reply) => {
    if (!requireLocalAdmin(req, reply)) return;
    if (!ACTION_ID_PATTERN.test(req.params.id)) return error(reply, 400, "DEVICE_ACTION_INVALID_REQUEST_ID");
    return { success: true, data: store.logsFor(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/device-actions/local/:id/trust", async (req, reply) => {
    if (!requireLocalAdmin(req, reply)) return;
    const local = store.get(req.params.id);
    if (!local) return error(reply, 404, "DEVICE_ACTION_NOT_FOUND");
    if (local.status !== "awaiting_trust") return error(reply, 409, "DEVICE_ACTION_TRUST_NOT_PENDING");
    trust.grant(identityFrom(local), local.permissions);
    store.transition(local.requestId, "preparing");
    void runAction(store, client, local.requestId, host.config.workspaceDir, host.config.dataDir);
    return { success: true, data: store.snapshot(local.requestId) };
  });

  app.post("/api/device-actions/local/trust/revoke", async (req, reply) => {
    if (!requireLocalAdmin(req, reply)) return;
    if (!isRecord(req.body)) return error(reply, 400, "DEVICE_ACTION_INVALID_TRUST_IDENTITY");
    try {
      const identity = {
        sourceOrigin: typeof req.body.sourceOrigin === "string" ? req.body.sourceOrigin : "",
        appOwner: typeof req.body.appOwner === "string" ? req.body.appOwner : "",
        appName: typeof req.body.appName === "string" ? req.body.appName : "",
        publisherUserId: typeof req.body.publisherUserId === "string" ? req.body.publisherUserId : "",
        publisherDisplayName: typeof req.body.publisherDisplayName === "string" ? req.body.publisherDisplayName : null,
      };
      return { success: true, data: { revoked: trust.revoke(identity) } };
    } catch {
      return error(reply, 400, "DEVICE_ACTION_INVALID_TRUST_IDENTITY");
    }
  });

  app.post<{ Params: { id: string } }>("/api/device-actions/local/:id/cancel", async (req, reply) => {
    if (!requireLocalAdmin(req, reply)) return;
    const local = store.get(req.params.id);
    if (!local) return error(reply, 404, "DEVICE_ACTION_NOT_FOUND");
    try {
      const updated = store.transition(local.requestId, "cancelled");
      await client.cancel(local.sourceOrigin, local.requestId, local.callbackToken).catch(() => {});
      return { success: true, data: store.snapshot(updated.requestId) };
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "DEVICE_ACTION_CANCEL_FAILED";
      return error(reply, 409, code);
    }
  });

  app.decorate("deviceActionLocalStore", store);

async function runAction(
  store: DeviceActionLocalStore,
  client: DeviceActionClient,
  requestId: string,
  workspaceDirectory: string,
  dataDirectory: string,
): Promise<void> {
  const action = store.get(requestId);
  if (!action) return;
  try {
    await client.update(action.sourceOrigin, action.requestId, action.callbackToken, "preparing");
    store.transition(requestId, "running");
    await client.update(action.sourceOrigin, action.requestId, action.callbackToken, "running");
    const result = await executeDeviceAction({
      id: action.requestId,
      script: action.script,
      input: action.input,
      context: {
        serverOrigin: action.sourceOrigin,
        app: { owner: action.appOwner, name: action.appName, version: action.appVersion, publisherUserId: action.publisherUserId },
        action: { id: action.requestId, workingDirectory: path.join(workspaceDirectory, "device-actions", action.requestId) },
      },
      permissions: canonicalizeDeviceActionPermissions(action.permissions),
      timeoutSeconds: action.timeoutSeconds,
      workingDirectory: path.join(workspaceDirectory, "device-actions", action.requestId),
      dataDirectory,
    });
    store.transition(requestId, "succeeded", result, null);
    await client.update(action.sourceOrigin, action.requestId, action.callbackToken, "succeeded", result, null);
  } catch (caught) {
    const code = caught instanceof DeviceActionExecutionError ? caught.code : "DEVICE_ACTION_REMOTE_UPDATE_FAILED";
    const message = caught instanceof Error ? caught.message : String(caught);
    const current = store.get(requestId);
    if (current && !["cancelled", "succeeded", "failed"].includes(current.status)) {
      try { store.transition(requestId, code === "DEVICE_ACTION_CANCELLED" ? "cancelled" : "failed", undefined, { code, message }); } catch { /* preserve the first terminal result */ }
    }
    if (current) await client.update(action.sourceOrigin, action.requestId, action.callbackToken, code === "DEVICE_ACTION_CANCELLED" ? "cancelled" : "failed", undefined, { code, message }).catch(() => {});
  }
}

function identityFrom(action: LocalDeviceActionRecord) {
  return {
    sourceOrigin: action.sourceOrigin,
    appOwner: action.appOwner,
    appName: action.appName,
    publisherUserId: action.publisherUserId,
    publisherDisplayName: action.publisherDisplayName,
  };
}

}
