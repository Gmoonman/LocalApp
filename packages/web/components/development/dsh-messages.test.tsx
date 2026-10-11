import React from "react";
import { it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DshMessages } from "./dsh-view";
vi.mock("./tool-call-row", () => ({ ToolCallRow: ({ call, result }: any) => <div data-testid="tool">{call.name}:{result?.content?.[0]?.text ?? "pending"}</div> }));
it("shows calls before completion and attaches results to one row per call", () => {
  const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "bash", arguments: {} }] }];
  const view = render(<DshMessages messages={messages} running />);
  expect(screen.queryByTestId("tool")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /查看过程/ }));
  expect(screen.getAllByTestId("tool")).toHaveLength(2);
  expect(screen.getByText("read:pending")).toBeVisible();
  view.rerender(<DshMessages messages={[...messages, { role: "toolResult", toolCallId: "b", content: [{ text: "second result" }] }, { role: "toolResult", toolCallId: "a", content: [{ text: "first result" }] }]} />);
  expect(screen.getAllByTestId("tool")).toHaveLength(2);
  expect(screen.getByText("read:first result")).toBeVisible();
  expect(screen.getByText("bash:second result")).toBeVisible();
});
it("retains a result when its call was not loaded", () => {
  render(<DshMessages messages={[{ role: "toolResult", toolCallId: "missing", content: [{ text: "orphan result" }] }]} />);
  fireEvent.click(screen.getByRole("button", { name: "查看处理过程" }));
  expect(screen.getByText("工具结果:orphan result")).toBeVisible();
});

it("keeps the answer visible while updates never open process details automatically", () => {
  const process = { role: "assistant", content: [{ type: "toolCall", id: "one", name: "read" }] };
  const view = render(<DshMessages messages={[process]} running />);
  expect(screen.queryByTestId("tool")).toBeNull();
  view.rerender(<DshMessages messages={[process, { role: "assistant", content: "最终回答" }]} />);
  expect(screen.getByText("最终回答")).toBeVisible();
  expect(screen.queryByTestId("tool")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看处理过程" }));
  expect(screen.getByTestId("tool")).toBeVisible();
});
