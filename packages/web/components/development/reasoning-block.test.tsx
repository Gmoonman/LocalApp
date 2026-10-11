import React from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReasoningBlock } from "./reasoning-block";
vi.mock("./dsh-view", () => ({ DshMarkdown: ({ text }: { text: string }) => <div data-testid="reasoning-body">{text}</div> }));
it("uses the DSH summary row and lazily opens the reasoning body", () => {
  render(<ReasoningBlock text="检查代码后回答。\n第二段" />);
  const trigger = screen.getByRole("button", { name: /思考/ });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("reasoning-body")).toBeNull();
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(screen.getByTestId("reasoning-body")).toHaveTextContent("第二段");
  fireEvent.keyDown(trigger, { key: " " });
  expect(screen.queryByTestId("reasoning-body")).toBeNull();
});
