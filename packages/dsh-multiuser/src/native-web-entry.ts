import { AppWebEntry } from "@deepseek-ai/dsh-client-web";
import "@deepseek-ai/dsh-client-ui-theme/brand-font.css";

const root = document.getElementById("root");
if (!root) throw new Error("Native client mount point is missing");
const entry = new AppWebEntry(root);
void entry.run();
window.addEventListener("pagehide", () => { void entry.dispose(); }, { once: true });
