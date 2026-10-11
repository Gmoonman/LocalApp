import React from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolCallRow } from "./tool-call-row";
vi.mock("./dsh-view", () => ({ DshRead: ({ text }: { text: string }) => <pre>{text}</pre>, DshTerminal: ({ output }: { output: string }) => <pre>{output}</pre> }));
it("shows an in-progress call before its result and preserves the expandable command and output", () => {
  const call = { id: "one", name: "bash", arguments: { command: "pwd" } };
  const view = render(<ToolCallRow call={call} running />);
  expect(screen.getByRole("button")).toHaveTextContent("pwd");
  expect(screen.getByRole("button").closest('[data-state]')).toHaveAttribute("data-state", "running");
  view.rerender(<ToolCallRow call={call} result={{ content: [{ text: "/workspace" }] }} />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("/workspace")).toBeVisible();
  expect(screen.getByText("参数")).toBeVisible();
});
it("uses the failed result's first line as the summary and retains the full error", () => {
  render(<ToolCallRow call={{ name: "read", arguments: { path: "missing.txt" } }} result={{ isError: true, content: [{ text: "File missing\nDetails" }] }} />);
  expect(screen.getByRole("button")).toHaveTextContent("File missing");
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText(/Details/)).toBeVisible();
});
