import React from "react";
import {render,screen} from "@testing-library/react";
import {expect,it,vi} from "vitest";
import {DshDevelopmentShell,type DevelopmentShellProps} from "./dsh-development-shell";
vi.mock("@localapp/dsh-app-development/ui/development-entry",()=>({NativeDevelopmentEntry:()=> <div>原生开发入口</div>}));
it("keeps the compatibility name without a copied layout or another agent loop",()=>{
  const run=vi.fn();
  const view=render(<DshDevelopmentShell {...({actions:{run}} as unknown as DevelopmentShellProps)}/>);
  expect(screen.getByText("原生开发入口")).toBeVisible();
  expect(screen.queryByLabelText("开发需求")).toBeNull();
  expect(run).not.toHaveBeenCalled();
  view.unmount();
});
