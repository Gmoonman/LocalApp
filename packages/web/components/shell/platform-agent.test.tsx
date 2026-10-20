import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { usePlatformAgent } from "./platform-agent";
const mocks = vi.hoisted(() => ({ create: vi.fn(), dispose: vi.fn(), abort: vi.fn() }));
vi.mock("@localapp/sdk-agent/harness-client", () => ({
  HarnessAgent: class {
    state = { isStreaming: false, messages: [], errorMessage: null };
    constructor(options: unknown) { mocks.create(options); }
    subscribe() { return () => {}; }
    dispose = mocks.dispose;
    abort = mocks.abort;
  },
  toChatMessages: () => [],
}));
it("does not create an Agent while disabled and disposes it when disabled again", async () => {
  const options = { appName: "demo", userName: "owner", pagePath: "owner/demo", postToolCall: vi.fn(), registeredToolsRef: { current: [] }, systemHintRef: { current: "" } };
  const { result, rerender } = renderHook(({ enabled }) => usePlatformAgent({ ...options, enabled }), { initialProps: { enabled: false } });
  expect(mocks.create).not.toHaveBeenCalled();
  await expect(result.current.agentSend("test")).rejects.toThrow("此应用已关闭 Agent 对话框");
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.harness).not.toBeNull());
  expect(mocks.create).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  expect(result.current.harness).toBeNull();
});
