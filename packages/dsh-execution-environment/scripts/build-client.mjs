import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildLocalappClient} from "../../server/scripts/build-localapp-client.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
await buildLocalappClient(root,path.join(root,"dist/client.cjs"),"@localapp/dsh-execution-environment");
