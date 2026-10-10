import { shellQuote } from "./python-environment.cjs";
export type EnvironmentCheck = { id: string; name: string; status: "ready" | "missing" | "blocked"; detail: string; required: boolean };
export type AgentEnvironment = { checkedAt: string; platform: string; ready: boolean; checks: EnvironmentCheck[] };

// Fixed command, executed by the same DSH shell and sandbox as Agent commands.
// No package installation, network requests, or model calls.
export function environmentProbe(executable?: string) { return ENVIRONMENT_PROBE.replace("python3 python /Library/Developer/CommandLineTools/usr/bin/python3", executable ? shellQuote(executable) : "python3 python /Library/Developer/CommandLineTools/usr/bin/python3"); }
export const ENVIRONMENT_PROBE = `
probe='import sys,json,importlib,shutil
modules={}
for name in ["pypdf","pdfplumber","reportlab","pypdfium2","docx","openpyxl","markitdown","pdfminer","mammoth","pandas"]:
 try:
  importlib.import_module(name)
  modules[name]=True
 except Exception:
  modules[name]=False
print(json.dumps({"version":list(sys.version_info[:3]),"python":sys.executable,"modules":modules,"commands":{name:bool(shutil.which(name)) for name in ["pdftoppm","libreoffice","soffice","tesseract"]}}))'
for executable in python3 python /Library/Developer/CommandLineTools/usr/bin/python3; do
 "$executable" -c "$probe" 2>/dev/null || true
done
`;
export const PUBLIC_SKILL_PYTHON_MODULES: Record<string, string[]> = {
 pdf: ["pypdf", "pdfplumber", "reportlab"], docx: ["docx"], xlsx: ["openpyxl"], markitdown: ["markitdown", "pdfminer", "mammoth", "pandas", "openpyxl"],
};
const packageNames: Record<string, string> = { docx: "python-docx", pdfminer: "pdfminer.six" };
export function summarizeEnvironment(stdout: string, selected: string[], initial: EnvironmentCheck[]): AgentEnvironment {
 const probes: Array<{version:number[];python:string;modules:Record<string,boolean>;commands:Record<string,boolean>}> = [];
 for (const line of stdout.split("\n")) {
  try { const p=JSON.parse(line); if (Array.isArray(p.version) && typeof p.python === "string" && p.modules && p.commands) probes.push(p); } catch { /* Ignore interpreter diagnostics. */ }
 }
 const required = [...new Set(selected.flatMap(id => PUBLIC_SKILL_PYTHON_MODULES[id] ?? []))];
 const supported = (p: typeof probes[number]) => p.version[0] > 3 || p.version[0] === 3 && p.version[1] >= 10;
 probes.sort((a,b) => Number(supported(b))-Number(supported(a)) || required.filter(m=>b.modules[m]).length-required.filter(m=>a.modules[m]).length);
 const python = probes[0];
 const checks = [...initial, { id:"python",name:"Python 3.10+",status:python && supported(python) ? "ready" : "missing",detail:python ? `${python.version.join(".")} · ${python.python}` : "Agent 执行环境中未找到可运行的 Python。",required: selected.length>0 } as EnvironmentCheck];
 for (const module of required) checks.push({id:module,name:packageNames[module] ?? module,status:python?.modules[module] ? "ready" : "missing",detail:python?.modules[module] ? "已在上述 Python 中成功导入。" : "上述 Python 缺少此依赖或无法导入；请在对应环境安装后重新检查。",required:true});
 if (selected.includes("pdf")) checks.push({id:"pdf-render",name:"PDF 渲染",status:python?.modules.pypdfium2 || python?.commands.pdftoppm ? "ready":"missing",detail:"可选：pypdfium2 或 Poppler，用于将页面转成图片。",required:false});
 if (selected.some(s=>s==="docx" || s==="xlsx")) checks.push({id:"office",name:"LibreOffice",status:python?.commands.libreoffice || python?.commands.soffice ? "ready":"missing",detail:"可选：用于 Word 渲染及 Excel 公式重算。",required:false});
 return {checkedAt:new Date().toISOString(),platform:process.platform,ready:checks.filter(c=>c.required).every(c=>c.status==="ready"),checks};
}
