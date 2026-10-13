import fs from "node:fs";
import path from "node:path";
export interface DocumentEnvironment { checks: Array<{ id: string; status: string }> }
export const DOCUMENT_SKILLS_ROOT = path.resolve(__dirname, "../skills");
export const PUBLIC_SKILL_PYTHON_MODULES: Record<string, string[]> = {
 pdf: ["pypdf", "pdfplumber", "reportlab"], docx: ["docx"], xlsx: ["openpyxl"], markitdown: ["markitdown", "pdfminer", "mammoth", "pandas", "openpyxl"],
};

export const PUBLIC_AGENT_SKILLS = [
  { id: "markitdown", name: "MarkItDown", description: "将 PDF、Word、Excel 等文档转为 Markdown", dependencies: "Python 3.10+、markitdown；扫描件需要额外 OCR" },
  { id: "pdf", name: "PDF", description: "提取文字和表格、创建、合并、拆分及填写 PDF", dependencies: "Python 3.10+、pypdf、reportlab、pdfplumber；渲染需要 pypdfium2 或 Poppler" },
  { id: "docx", name: "Word / DOCX", description: "读取、创建和编辑 Word 文档", dependencies: "Python 3.10+、python-docx；渲染需要 LibreOffice" },
  { id: "xlsx", name: "Excel / XLSX", description: "读取、创建和编辑工作簿", dependencies: "Python 3.10+、openpyxl；公式重算需要 LibreOffice" },
] as const;

/** Materialize only selected bundles inside the isolated application workspace. */
export function preparePublicSkills(workspace: string, selected: string[], root: string) {
  if (!path.isAbsolute(root)) throw new Error("Public Skills directory must be an absolute path");
  const destination = path.join(workspace, ".localapp-public-skills");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const id of new Set(selected)) {
    if (!PUBLIC_AGENT_SKILLS.some((skill) => skill.id === id)) throw new Error("Unknown public skill");
    fs.cpSync(path.join(root, id), path.join(destination, id), { recursive: true, dereference: false });
  }
  return destination;
}

export function publicSkillAvailability(report:DocumentEnvironment) {
 const ready=(id:string)=>report.checks.some(c=>c.id===id && c.status==="ready");
 return PUBLIC_AGENT_SKILLS.map(skill=>({...skill,available:["runner","python",...PUBLIC_SKILL_PYTHON_MODULES[skill.id]].every(ready),unavailableReason:"系统文档处理环境尚未就绪，请联系管理员检查依赖。"}));
}
