export interface IssueTemplateConfig {
  id: string;
  name: string;
  description: string;
  titlePrefix: string;
  body: string;
  type: "task" | "bug" | "feature";
  labels: string[];
}

export class IssueTemplateConfigError extends Error {
  readonly code = "invalid_issue_templates";

  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "IssueTemplateConfigError";
  }
}

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEMPLATES = 10;
const MAX_ID_LENGTH = 40;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_TITLE_PREFIX_LENGTH = 80;
const MAX_BODY_LENGTH = 20_000;
const MAX_LABELS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, path: string, maximum: number, required: boolean, trim: boolean): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new IssueTemplateConfigError(path, "must be a string");
  const normalized = trim ? value.trim() : value;
  const length = Array.from(normalized).length;
  if (required && length === 0) throw new IssueTemplateConfigError(path, "must not be empty");
  if (length > maximum) throw new IssueTemplateConfigError(path, `must not exceed ${maximum} characters`);
  return normalized;
}

export function parseIssueTemplatesConfig(manifest: unknown): IssueTemplateConfig[] {
  if (!isRecord(manifest)) throw new IssueTemplateConfigError("manifest", "must be an object");
  if (manifest.issues === undefined) return [];
  if (!isRecord(manifest.issues)) throw new IssueTemplateConfigError("issues", "must be an object");
  if (manifest.issues.templates === undefined) return [];
  if (!Array.isArray(manifest.issues.templates)) throw new IssueTemplateConfigError("issues.templates", "must be an array");
  if (manifest.issues.templates.length > MAX_TEMPLATES) throw new IssueTemplateConfigError("issues.templates", `must not contain more than ${MAX_TEMPLATES} templates`);

  const seenIds = new Set<string>();
  return manifest.issues.templates.map((value, index) => {
    const basePath = `issues.templates[${index}]`;
    if (!isRecord(value)) throw new IssueTemplateConfigError(basePath, "must be an object");
    const id = readString(value.id, `${basePath}.id`, MAX_ID_LENGTH, true, true);
    if (!TEMPLATE_ID_PATTERN.test(id)) throw new IssueTemplateConfigError(`${basePath}.id`, "must use lowercase letters, numbers, and single hyphens");
    if (seenIds.has(id)) throw new IssueTemplateConfigError(`${basePath}.id`, "must be unique");
    seenIds.add(id);

    const labelsPath = `${basePath}.labels`;
    if (value.labels !== undefined && !Array.isArray(value.labels)) throw new IssueTemplateConfigError(labelsPath, "must be an array");
    const rawLabels = value.labels ?? [];
    if (rawLabels.length > MAX_LABELS) throw new IssueTemplateConfigError(labelsPath, `must not contain more than ${MAX_LABELS} labels`);
    const labels: string[] = [];
    for (let labelIndex = 0; labelIndex < rawLabels.length; labelIndex += 1) {
      const label = readString(rawLabels[labelIndex], `${labelsPath}[${labelIndex}]`, 100, true, true);
      if (!labels.includes(label)) labels.push(label);
    }

    const type = value.type ?? "task";
    if (type !== "task" && type !== "bug" && type !== "feature") throw new IssueTemplateConfigError(`${basePath}.type`, "must be task, bug, or feature");
    return {
      id,
      name: readString(value.name, `${basePath}.name`, MAX_NAME_LENGTH, true, true),
      description: readString(value.description, `${basePath}.description`, MAX_DESCRIPTION_LENGTH, true, true),
      titlePrefix: readString(value.titlePrefix, `${basePath}.titlePrefix`, MAX_TITLE_PREFIX_LENGTH, false, false),
      body: readString(value.body, `${basePath}.body`, MAX_BODY_LENGTH, false, false),
      type,
      labels,
    };
  });
}
