import React from "react";
import { it, expect, vi, beforeAll, afterAll } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentInteractionCard } from "./agent-interaction-card";
beforeAll(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterAll(() => vi.unstubAllGlobals());
const question = { id: "task", question: "你想做什么？", options: [{ label: "审阅 PR", description: "检查代码改动" }, { label: "解释代码" }] };
it("submits a single choice and custom answer with the existing protocol", () => {
  const answer = vi.fn();
  render(<AgentInteractionCard interaction={{ token: "test", kind: "questions", questions: [question] }} answer={answer} />);
  expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /审阅 PR/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "PR 42" } });
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(answer).toHaveBeenCalledWith({ answers: [{ id: "task", selected: ["审阅 PR"], custom: "PR 42" }] });
});
it("supports multiple choices and disables duplicate submission while pending", () => {
  const answer = vi.fn();
  const interaction = { token: "test", kind: "questions" as const, questions: [{ ...question, multiSelect: true }] };
  const view = render(<AgentInteractionCard interaction={interaction} answer={answer} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /审阅 PR/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "解释代码" }));
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(answer).toHaveBeenCalledWith({ answers: [{ id: "task", selected: ["审阅 PR", "解释代码"], custom: "" }] });
  view.rerender(<AgentInteractionCard interaction={interaction} answer={answer} pending />);
  expect(screen.getByRole("button", { name: "正在提交…" })).toBeDisabled();
});
it("preserves approval responses", () => {
  const answer = vi.fn();
  render(<AgentInteractionCard interaction={{ token: "test", kind: "approval", toolName: "write" }} answer={answer} />);
  fireEvent.click(screen.getByRole("button", { name: "允许本次操作" }));
  expect(answer).toHaveBeenLastCalledWith("allowed-once");
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect(answer).toHaveBeenLastCalledWith("rejected");
});
