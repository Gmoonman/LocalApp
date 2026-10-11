import { Context } from "@deepseek-ai/cordis";
import Multiuser from "@localapp/dsh-multiuser";
import Fastify from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("serves dependency installers from an explicit directory and stops access with its plugin", async () => {
  const root = path.resolve(import.meta.dirname, "../../../../../tmp/plugin-dependency-tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "data-"));
  const context = new Context();
  const app = Fastify();
  try {
    await context.plugin(Multiuser);
    await context.localappMultiuser.registerDependencies(app, directory);
    expect((await app.inject("/api/deps/node")).statusCode).toBe(404);
    await fs.mkdir(path.join(directory, "node", "test"), { recursive: true });
    await fs.writeFile(path.join(directory, "node.json"), JSON.stringify({ version: "test", platforms: { "darwin/arm64": "node.pkg" } }));
    await fs.writeFile(path.join(directory, "node", "test", "node.pkg"), Buffer.from([0, 255, 12]));
    expect((await app.inject("/api/deps/node")).json().version).toBe("test");
    expect((await app.inject("/api/deps/node/download")).statusCode).toBe(400);
    expect((await app.inject("/api/deps/node/download?os=linux&arch=x64")).statusCode).toBe(404);
    const installer = await app.inject("/api/deps/node/download?os=darwin&arch=arm64");
    expect(installer.statusCode).toBe(200);
    expect(installer.rawPayload).toEqual(Buffer.from([0, 255, 12]));
    await context.fiber.dispose();
    expect((await app.inject("/api/deps/node")).statusCode).toBe(503);
    expect((await app.inject("/api/deps/node/download?os=darwin&arch=arm64")).statusCode).toBe(503);
  } finally {
    await app.close(); await context.fiber.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
