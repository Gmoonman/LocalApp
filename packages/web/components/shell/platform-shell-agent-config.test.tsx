import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformShell } from "./platform-shell";

const useAgent = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/auth-modals/auth-provider", () => ({ useAuthModals: () => ({ openLogin: vi.fn() }) }));
vi.mock("./platform-agent", () => ({ usePlatformAgent: useAgent, registerAgentToolCatalog: vi.fn() }));
vi.mock("../development/app-conversation-dock", () => ({ AppConversationDock: () => <div data-testid="agent-dock" /> }));
class MockEventSource { addEventListener() {} close() {} }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  useAgent.mockReset();
  useAgent.mockReturnValue({ harness: null, agentSend: vi.fn(), handleToolResult: vi.fn(), synchronizeContext: vi.fn() });
  vi.stubGlobal("EventSource", MockEventSource);
});

describe("application Agent conversation configuration", () => {
  it.each([
    { value: undefined, user: "owner", enabled: false },
    { value: true, user: "visitor", enabled: true },
    { value: false, user: "owner", enabled: false },
    { value: false, user: "visitor", enabled: false },
  ])("value=$value user=$user enables=$enabled", async ({ value, user, enabled }) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return json({ success: true, data: { id: user, name: user } });
      if (url === "/api/system/plugins") return json({ success: true, data: { development: true } });
      if (url.endsWith("/meta")) return json({ success: true, data: { name: "demo", userId: "owner", lifecycleStatus: "online", shell: { agentConversation: value } } });
      if (url.includes("/api/favorites")) return json({ success: true, data: { count: 0, favorited: false } });
      if (url.startsWith("/api/issues?")) return json({ success: true, data: [], meta: { open: 0 } });
      return new Response('<html><body><div id="root"></div></body></html>', { headers: { "Content-Type": "text/html" } });
    }));
    render(<PlatformShell userId="owner" name="demo" />);
    await waitFor(() => expect(document.querySelector("[data-localapp-native-shell]")).not.toBeNull());
    await waitFor(() => expect(useAgent).toHaveBeenLastCalledWith(expect.objectContaining({ enabled })));
    if (enabled) {
      expect(await screen.findByTestId("agent-dock")).toBeInTheDocument();
      expect(screen.getByTitle("AI 助手")).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId("agent-dock")).not.toBeInTheDocument();
      expect(screen.queryByTitle("AI 助手")).not.toBeInTheDocument();
      const responses: unknown[] = [];
      const listener = (event: MessageEvent) => { if (event.data?.type === "localapp:platform_response") responses.push(event.data); };
      window.addEventListener("message", listener);
      for (const capability of ["ai.open", "ai.toggle"]) window.dispatchEvent(new CustomEvent("localapp:platform_request", {
        cancelable: true, detail: { type: "localapp:platform_request", id: capability, capability },
      }));
      window.removeEventListener("message", listener);
      expect(responses).toEqual(["ai.open", "ai.toggle"].map(id => ({ type: "localapp:platform_response", id, ok: false, error: "此应用已关闭 Agent 对话框" })));
    }
  });
});
