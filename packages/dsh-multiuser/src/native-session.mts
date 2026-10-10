import { Context } from "@deepseek-ai/cordis";
import TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import * as Remotes from "@deepseek-ai/dsh-api-remotes";
import SessionController, { type SessionCreateRequest } from "@deepseek-ai/dsh-api-session-controller";
import { TYPERT } from "@deepseek-ai/dsh-api-session-controller/typert";
import DefaultModel from "@deepseek-ai/dsh-agent-default-model";
import Attachments from "@deepseek-ai/dsh-attachment-local";
import FileUploads from "@deepseek-ai/dsh-client-file-upload";
import SessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import WorkspaceRegistry from "@deepseek-ai/dsh-workspace";
import WorkspaceController, { type WorkspaceCreateRequest } from "@deepseek-ai/dsh-api-workspace-controller";
import { TYPERT as WORKSPACE_TYPERT } from "@deepseek-ai/dsh-api-workspace-controller/typert";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedWebServer from "./native-server.mjs";
import { mountNativeConnection, type NativeConnectionConfig } from "./native-connection.mjs";

export interface NativeSessionConfig extends NativeConnectionConfig {
  workspaceRoot: string;
  model: string;
}

/** Add dsh's real SessionController and Gateway to an isolated user's Harness. */
export async function mountNativeSessions(ctx: Context, config: NativeSessionConfig) {
  const workspaceRoot = path.resolve(config.workspaceRoot);
  const nativeContext = ctx.isolate("sessionController");
  await nativeContext.plugin(EmbeddedWebServer, { host: "127.0.0.1", port: 0 });
  const transport = await mountNativeConnection(nativeContext, config);
  await nativeContext.plugin(TypertRegistry);
  nativeContext.typert.register(TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  nativeContext.typert.register(WORKSPACE_TYPERT as Parameters<typeof nativeContext.typert.register>[0]);
  await nativeContext.plugin(DefaultModel, { provider: "localapp", model: config.model });
  await nativeContext.plugin(Attachments, { dshHome: config.root });
  await nativeContext.plugin(WorkspaceRegistry);
  class ApplicationWorkspaceController extends WorkspaceController {
    override create(request: WorkspaceCreateRequest) {
      if (path.resolve(request.path) !== workspaceRoot) throw new Error("Workspace is outside the application workspace");
      return super.create({ path: workspaceRoot });
    }
    override async initializeDefault(signal: AbortSignal) {
      signal.throwIfAborted();
      await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      const value = await this.create({ path: workspaceRoot });
      return { workspace: value.workspace };
    }
  }
  await nativeContext.plugin(ApplicationWorkspaceController);
  await nativeContext.plugin(SessionQuery, { path: path.join(config.root, "session-search.sqlite") });
  await nativeContext.plugin(FileUploads);

  // Upstream creation uses node:fs mkdir, so validate the workspace before it
  // reaches that operation. The application decides the directory, not a client.
  class ApplicationSessionController extends SessionController {
    private readonly creating = new Set<string>();
    override async create(request: SessionCreateRequest) {
      if (request.sessionId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(request.sessionId)) {
        throw new Error("Invalid session ID");
      }
      const selected = request.workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(request.workspaceId);
      const cwd = selected?.path ?? request.cwd ?? workspaceRoot;
      if (path.resolve(cwd) !== workspaceRoot) throw new Error("Session workspace is outside the application workspace");
      const existing = request.sessionId !== undefined && this.ctx.agents.list().some(agent => agent.id === request.sessionId);
      if (!existing && this.ctx.agents.list().length + this.creating.size >= 10) throw new Error("Too many agent sessions");
      // Distinct reservations count concurrent requests with generated IDs too.
      const reservation = request.sessionId ?? `pending-${randomUUID()}`;
      if (this.creating.has(reservation)) throw new Error("Agent session is already being created");
      this.creating.add(reservation);
      try { return await super.create(request.workspaceId === undefined ? { ...request, cwd: workspaceRoot } : request); }
      finally { this.creating.delete(reservation); }
    }
  }
  await nativeContext.plugin(ApplicationSessionController, { nativeOpen: false });
  if (!nativeContext.get("sessionController")) throw new Error("Native SessionController dependencies are not ready");
  await nativeContext.plugin(Gateway);
  await nativeContext.plugin(Remotes);
  return { transport, gateway: nativeContext.typertGateway };
}
