import React from "react";
import { beforeEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateApplicationDialog } from "./create-application-dialog";
vi.mock("./dsh-view", () => ({
  DshMessages: ({ messages }: any) => <div>{JSON.stringify(messages)}</div>,
  DshMarkdown: ({ text }: any) => <p>{text}</p>,
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: vi.fn(),
    configurable: true,
  });
});
it("discusses first, confirms an agent proposal, and navigates with the same conversation", async () => {
  const creation = {
    projectId: "project",
    sessionId: "original-session",
    providerId: "model",
  };
  const proposal = { name: "task-board", description: "追踪工作项" };
  let proposed = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (data: unknown) =>
      new Response(JSON.stringify({ success: true, data }), {
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/agent/settings")
      return ok({
        providers: [{ id: "model", name: "Model", model: "test" }],
        defaultProviderId: "model",
      });
    if (url === "/api/development/creations") return ok(creation);
    if (url.endsWith("/api/session/create")) {
      expect(JSON.parse(init!.body as string).payload.args.request.sessionId).toBe("original-session");
      return new Response(JSON.stringify({ result: { ok: true, value: { sessionId: "original-session" } } }));
    }
    if (url.endsWith("/api/session/prompt")) {
      const input = JSON.parse(init!.body as string).payload.args.request;
      expect(input.sessionId).toBe("original-session");
      expect(input.content).toEqual([{ type: "text", text: "做一个工作项应用" }]);
      proposed = true;
      return new Response(JSON.stringify({ result: { ok: true, value: { accepted: true } } }));
    }
    if (url.endsWith("/confirm")) {
      expect(JSON.parse(init!.body as string)).toEqual({ name: "task-board" });
      return ok({ ...creation, url: "/alice/task-board/?creation=project" });
    }
    if (url.includes("/agent/history"))
      return ok([{ role: "user", content: "做一个工作项应用" }]);
    return ok({ ...creation, ...(proposed ? { proposal } : {}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  const created = vi.fn();
  render(
    <CreateApplicationDialog open onOpenChange={vi.fn()} onCreated={created} />,
  );
  expect(await screen.findByText("我们要构建什么？")).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("combobox")).toHaveTextContent("Model"),
  );
  expect(
    fetchMock.mock.calls.some(([url, init]) => url === "/api/development/creations" && init?.method === "POST"),
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("创建应用需求"), {
    target: { value: "做一个工作项应用" },
  });
  fireEvent.click(screen.getByLabelText("发送创建需求"));
  const confirm = await screen.findByRole("button", { name: "确认名称并创建" });
  expect(screen.getByTitle("原生应用开发对话")).toHaveAttribute("src", "/api/development/projects/project/native/model/?localappCompact=1");
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/agent/run"))).toBe(false);
  expect(created).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(created).toHaveBeenCalledWith("/alice/task-board/?creation=project"),
  );
});
it("retries a rejected first prompt using the existing draft and native session", async () => {
  const draft = { projectId: "retry-project", sessionId: "retry-session", providerId: "model" };
  let attempts = 0;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
    if (url === "/api/agent/settings") return ok({ providers: [{ id: "model", name: "Model", model: "test" }], defaultProviderId: "model" });
    if (url === "/api/development/creations") return ok(draft);
    if (url.endsWith("/api/session/create")) return new Response(JSON.stringify({ result: { ok: true, value: { sessionId: draft.sessionId } } }));
    if (url.endsWith("/api/session/prompt")) return new Response(JSON.stringify({ result: { ok: true, value: { accepted: ++attempts > 1 } } }));
    return ok(draft);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<CreateApplicationDialog open onOpenChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent("Model"));
  fireEvent.change(screen.getByLabelText("创建应用需求"), { target: { value: "retry application" } });
  fireEvent.click(screen.getByLabelText("发送创建需求"));
  expect(await screen.findByRole("alert")).toHaveTextContent("需求未发送");
  fireEvent.click(screen.getByLabelText("发送创建需求"));
  await screen.findByTitle("原生应用开发对话");
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/development/creations" && init?.method === "POST")).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/api/session/create"))).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/api/session/prompt"))).toHaveLength(2);
  const prompts = fetchMock.mock.calls.filter(([url]) => url.endsWith("/api/session/prompt")).map(([, init]) => JSON.parse(init!.body as string).payload.args.request);
  expect(prompts[0].requestId).toBe(prompts[1].requestId);
});
