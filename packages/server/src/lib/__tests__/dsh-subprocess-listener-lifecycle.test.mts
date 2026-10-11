import { Context } from "@deepseek-ai/cordis";
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local";
import { expect, it } from "vitest";

it("removes subprocess exit listeners after concurrent runtime disposal and reopening", async () => {
  const original = process.rawListeners("exit");
  for (let generation = 0; generation < 3; generation++) {
    const contexts = Array.from({ length: 4 }, () => new Context());
    try {
      await Promise.all(contexts.map(context => context.plugin(SubprocessLocal)));
      expect(process.listenerCount("exit")).toBe(original.length + contexts.length);
    } finally { await Promise.all(contexts.map(context => context.fiber.dispose())); }
    expect(process.rawListeners("exit")).toEqual(original);
  }
});
