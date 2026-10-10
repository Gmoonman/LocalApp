import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep one Node module instance for database connections and error classes.
    server: { deps: { external: [/\/dsh-app-platform\/dist\//] } },
    pool: "forks",
    fileParallelism: false,
    testTimeout: 20_000,
    exclude: ["**/dist/**", "**/node_modules/**", "tests/e2e-ui/**", "tests/e2e-unified/real-apps.spec.ts"],
  },
});
