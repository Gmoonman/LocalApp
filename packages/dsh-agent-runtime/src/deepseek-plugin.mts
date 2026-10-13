import type { Plugin } from "@deepseek-ai/cordis";

/** Resolve ESM and CommonJS plugin exports, including the packaged CJS wrapper. */
export function resolveDeepSeekPlugin(value: unknown): Plugin {
  const seen = new Set<unknown>();
  while (value && typeof value === "object" && "default" in value && !seen.has(value)) {
    seen.add(value);
    value = value.default;
  }
  // Cordis performs the final validation; preserve its error for invalid exports.
  return value as Plugin;
}
