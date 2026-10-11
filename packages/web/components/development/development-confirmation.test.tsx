import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DevelopmentPage } from "./development-page";
vi.mock("./app-development-dock", () => ({ AppDevelopmentDock: (props: any) => <>
  <button disabled={!props.projects.length || props.pending} onClick={() => props.actions.select(props.projects[0])}>选择应用</button>
  <button disabled={!props.build || props.pending} onClick={props.actions.publish}>发布</button>
  <button disabled={!props.version || props.pending} onClick={props.actions.restore}>恢复</button>
</> }));
afterEach(() => vi.unstubAllGlobals());
it.each(["发布", "恢复"])("waits for shadcn confirmation before %s changes Server state", async action => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const data = url === "/api/development/projects" ? [{id: "p", name: "app"}]
      : url === "/api/agent/settings" ? {providers: [], defaultProviderId: ""}
      : url.endsWith("/source") ? null
      : url.endsWith("/versions") ? [{id: "v1", message: "snapshot"}]
      : url.endsWith("/builds") ? [{id: "b1", status: "succeeded"}]
      : url.endsWith("/release-target") ? {version: 1}
      : url.endsWith("/releases") ? {url: "/owner/app/"} : [];
    return new Response(JSON.stringify({success: true, data}));
  });
  vi.stubGlobal("fetch", request);
  const view = render(<DevelopmentPage application={{owner:"owner",name:"app"}} />);
  await waitFor(() => expect(screen.getByText("选择应用")).not.toBeDisabled());
  fireEvent.click(screen.getByText("选择应用"));
  await waitFor(() => expect(screen.getByText(action)).not.toBeDisabled());
  fireEvent.click(screen.getByText(action));
  await screen.findByRole("dialog", {name: "确认应用操作"});
  const mutation = action === "发布" ? "/releases" : "/restore";
  expect(request.mock.calls.some(([url, init]) => url.endsWith(mutation) && init?.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", {name: /^取消$/}));
  await waitFor(() => expect(screen.getByText(action)).not.toBeDisabled());
  expect(request.mock.calls.some(([url, init]) => url.endsWith(mutation) && init?.method === "POST")).toBe(false);
  fireEvent.click(screen.getByText(action));
  fireEvent.click(await screen.findByRole("button", {name: /^确认$/}));
  await waitFor(() => expect(request.mock.calls.filter(([url, init]) => url.endsWith(mutation) && init?.method === "POST")).toHaveLength(1));
  view.unmount();
});
