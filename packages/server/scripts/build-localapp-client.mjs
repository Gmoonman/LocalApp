import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalappClient } from "../../dsh-multiuser/scripts/build-client.mjs";
export { buildLocalappClient };

// Compatibility entry for existing Server build callers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dsh-multiuser");
  await buildLocalappClient(sourceDirectory, path.join(sourceDirectory, "dist/client.cjs"));
}
