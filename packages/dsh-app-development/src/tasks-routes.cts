import type { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentKind } from "./agents/types.cjs";
import type { AgentRunner } from "./agent-runner.cjs";
import type { TaskEvent, TaskRunner } from "./task-runner.cjs";
import type { TaskStore } from "./task-store.cjs";

export async function registerTasks(
  app: FastifyInstance,
  services: { taskStore: TaskStore; taskRunner: TaskRunner; agentRunner: AgentRunner; user(request: import("fastify").FastifyRequest): string; isAdministrator(user: string): boolean },
): Promise<void> {
  const { taskStore, taskRunner, agentRunner } = services;
  const requireExecutionAdmin = (user: string, reply: FastifyReply) => {
    if (services.isAdministrator(user)) return true;
    reply.status(403).send({ success: false, error: "Administrator execution required" });
    return false;
  };

  app.get("/api/tasks", async (request) => ({ success: true, data: taskStore.list(services.user(request)) }));
  app.get("/api/tasks/capabilities", async () => ({ success: true, data: { agents: agentRunner.capabilities() } }));

  app.post("/api/tasks", async (request, reply) => {
    if (!requireExecutionAdmin(services.user(request), reply)) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      const task = await taskRunner.start({
        workspaceId: requiredString(body?.workspaceId, "workspaceId"),
        kind: requiredKind(body?.kind),
        executable: requiredString(body?.executable, "executable"),
        args: requiredStringArray(body?.args),
        timeoutMs: requiredInteger(body?.timeoutMs, "timeoutMs"),
        requestedBy: services.user(request),
      });
      return reply.status(201).send({ success: true, data: task });
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/api/tasks/agents", async (request, reply) => {
    if (!requireExecutionAdmin(services.user(request), reply)) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      const task = await agentRunner.start({
        workspaceId: requiredString(body?.workspaceId, "workspaceId"),
        agent: requiredAgent(body?.agent),
        prompt: requiredString(body?.prompt, "prompt"),
        timeoutMs: requiredInteger(body?.timeoutMs, "timeoutMs"),
        requestedBy: services.user(request),
      });
      return reply.status(201).send({ success: true, data: task });
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const task = taskStore.getOwned((request.params as { id: string }).id, services.user(request));
    if (!task) return reply.status(404).send({ success: false, error: "Task not found" });
    return { success: true, data: task };
  });

  app.post("/api/tasks/:id/cancel", async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      if (!taskStore.getOwned(id, services.user(request))) return reply.status(404).send({ success: false, error: "Task not found" });
      return { success: true, data: await taskRunner.cancel(id) };
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.get("/api/tasks/:id/logs", async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      if (!taskStore.getOwned(id, services.user(request))) return reply.status(404).send({ success: false, error: "Task not found" });
      const cursorValue = (request.query as { cursor?: unknown }).cursor;
      const cursor = cursorValue === undefined ? 0 : Number(cursorValue);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid log cursor");
      return { success: true, data: taskRunner.logs(id, cursor) };
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.get("/api/tasks/:id/events", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const task = taskStore.getOwned(id, services.user(request));
    if (!task) return reply.status(404).send({ success: false, error: "Task not found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let ended = false;
    const write = (event: TaskEvent) => {
      if (!ended) reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === "log" ? event : event.task)}\n\n`);
    };
    const finish = () => {
      if (ended) return;
      ended = true;
      reply.raw.end();
    };
    const initial: TaskEvent = { type: "status", taskId: id, status: task.status, task };
    if (task.status !== "running") {
      write(initial);
      finish();
      return;
    }
    const emitter: EventEmitter = taskRunner.events(id);
    const listener = (event: TaskEvent) => {
      write(event);
      if (event.status !== "running") {
        emitter.off("event", listener);
        finish();
      }
    };
    emitter.on("event", listener);
    const current = taskStore.getOwned(id, services.user(request));
    if (!current) {
      emitter.off("event", listener);
      finish();
      return;
    }
    write({ type: "status", taskId: id, status: current.status, task: current });
    if (current.status !== "running") {
      emitter.off("event", listener);
      finish();
      return;
    }
    request.raw.once("close", () => {
      emitter.off("event", listener);
      finish();
    });
  });

  app.post("/api/tasks/:id/messages", async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      const task = taskStore.getOwned(id, services.user(request));
      if (!task || task.kind !== "agent" || !isAgent(task.executable)) {
        return reply.status(404).send({ success: false, error: "Agent task not found" });
      }
      const body = request.body as { prompt?: unknown } | null;
      await agentRunner.send(id, requiredString(body?.prompt, "prompt"), task.executable);
      return reply.status(202).send({ success: true });
    } catch (error) {
      return taskError(reply, error);
    }
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("args must be an array of strings");
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function requiredKind(value: unknown): "build" | "test" | "git" | "agent" {
  if (value !== "build" && value !== "test" && value !== "git" && value !== "agent") throw new Error("Invalid task kind");
  return value;
}

function requiredAgent(value: unknown): AgentKind {
  if (!isAgent(value)) throw new Error("Invalid agent");
  return value;
}

function isAgent(value: unknown): value is AgentKind {
  return value === "codex" || value === "opencode";
}

function taskError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "WORKSPACE_NOT_FOUND" || message === "TASK_NOT_FOUND") {
    return reply.status(404).send({ success: false, error: "Task not found" });
  }
  if (message === "ADMIN_EXECUTION_REQUIRED") return reply.status(403).send({ success: false, error: "Administrator execution required" });
  return reply.status(400).send({ success: false, error: message });
}
