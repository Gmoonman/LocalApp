import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalappClient } from "../../dsh-multiuser/scripts/build-client.mjs";

const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await buildLocalappClient(sourceDirectory, path.join(sourceDirectory, "dist/client.cjs"), "@localapp/dsh-app-platform");
