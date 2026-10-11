import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { renderStarterDoc, starterDocRoutes } from "../src/routes/starter-doc.js";

describe("starter doc route", () => {
  it("serves unauthenticated markdown with the requesting origin substituted", async () => {
    const app = Fastify();
    starterDocRoutes(app);
    const response = await app.inject({ method: "GET", url: "/starter.md", headers: { host: "192.168.2.9:3000" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.body).toContain("当前实例：http://192.168.2.9:3000");
    expect(response.body).not.toContain("{{origin}}");
    expect(response.body).toContain("localapp login http://192.168.2.9:3000 --api-key");
    expect(response.body).toContain("localapp init my-app");
    expect(response.body).toContain("localapp check");
    expect(response.body).toContain("localapp app install");
    expect(response.body).toContain("localapp app pull --profile online");
    expect(response.body).toContain("localapp app push --profile online");
    expect(response.body).toContain("不会自动上线");
    await app.close();
  });

  it("renders every documented command without leaking the placeholder", () => {
    const rendered = renderStarterDoc("http://127.0.0.1:3000");
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain("AGENTS.md");
    expect(rendered).toContain("/my/keys");
  });
});
