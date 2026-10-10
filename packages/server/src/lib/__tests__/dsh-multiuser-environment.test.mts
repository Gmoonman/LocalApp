import { expect, it } from "vitest";
it("loads Python configuration and dependency checks from the standalone multiuser plugin", async () => {
  const python = await import("@localapp/dsh-multiuser/python-environment");
  const environment = await import("@localapp/dsh-multiuser/agent-environment");
  expect(python.shellQuote("/space dir/python")).toBe("'/space dir/python'");
  expect(environment.environmentProbe("/space dir/python")).toContain("'/space dir/python'");
  const report = environment.summarizeEnvironment(JSON.stringify({ version: [3, 12, 0], python: "python", modules: { docx: true }, commands: { soffice: true } }), ["docx"], []);
  expect(report.ready).toBe(true);
});
