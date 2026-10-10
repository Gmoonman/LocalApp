import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep one Node module instance for database connections and error classes.
    server: { deps: { external: [/\/dsh-app-platform\/dist\//] } },
    pool: "forks",
    fileParallelism: false,
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
