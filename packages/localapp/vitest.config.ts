import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plugin storage and database state must share the native Node module cache.
    server: { deps: { external: [/\/dsh-app-platform\/dist\//, /\/dsh-app-development\/dist\//] } },
    fileParallelism: false,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
