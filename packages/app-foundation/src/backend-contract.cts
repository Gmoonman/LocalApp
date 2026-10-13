import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkAccess } from "./access-control.cjs";
import { execQuerySqlWithBudget, execRawSql, getConnection, getDbPath, runDbTransaction, withDbQueue } from "./app-db.cjs";
import {
  LocalAppRuntimeError,
  isWasmRuntimeError,
  wrapDatabaseRuntimeError,
} from "./runtime-errors.cjs";
import type { AccessLevel } from "./models.cjs";
import { PLATFORM_CAPABILITIES } from "./platform-capabilities.cjs";

export const BACKEND_RESOURCE_SCHEMA_URL = "https://localapp.dev/schemas/backend/resource-schema.schema.json";
export const BACKEND_QUERIES_SCHEMA_URL = "https://localapp.dev/schemas/backend/queries.schema.json";
export const BACKEND_MUTATIONS_SCHEMA_URL = "https://localapp.dev/schemas/backend/mutations.schema.json";

export interface BackendManifestConfig {
  root?: string;
  include?: string[];
  queries?: unknown;
  mutations?: unknown;
  resources?: unknown;
}

export interface BackendContractFile {
  absolutePath: string;
  relativePath: string;
  schemaUrl: string;
  kind: "schema" | "queries" | "mutations" | "unknown";
}

export interface BackendResourceContract {
  schema: BackendResourceSchema;
  schemaFile: BackendContractFile;
}

export interface BackendResourceSchema {
  $schema: string;
  name: string;
  fields: Record<string, unknown>;
  [key: string]: unknown;
}

export type BackendAccessLevel = AccessLevel;

export interface BackendNamedSqlParam {
  type: "string" | "number" | "boolean" | "timestamp" | "unknown" | string;
  required?: boolean;
  nullable?: boolean;
  enum?: unknown[];
}

export type BackendNamedSqlResultMode = "page" | "single" | "aggregate" | "bounded";

export interface BackendNamedSqlResult {
  mode: BackendNamedSqlResultMode;
  maxRows?: number;
  maxBytes?: number;
}

export interface BackendGeneratedNamedSqlSecurity {
  mode: "generated";
  template: string;
  resource: string;
  config: Record<string, unknown>;
  digest: string;
}

export interface BackendCustomNamedSqlSecurity {
  mode: "custom";
  access: "public" | "authenticated" | "owner" | "owner-or-member";
  resources: string[];
  systemParams: string[];
  scenarios: Array<{
    identity: "anonymous" | "owner" | "member";
    expect: "allow" | "deny";
  }>;
}

export type BackendNamedSqlSecurity = BackendGeneratedNamedSqlSecurity | BackendCustomNamedSqlSecurity;

export interface BackendNamedSql {
  kind: "query" | "mutation";
  sql: string;
  params?: Record<string, BackendNamedSqlParam>;
  access?: BackendAccessLevel;
  acl?: string[];
  result?: BackendNamedSqlResult;
  security?: BackendNamedSqlSecurity;
  file?: BackendContractFile;
}

export interface BackendContract {
  files: BackendContractFile[];
  resources: Record<string, BackendResourceContract>;
  queries: Record<string, BackendNamedSql>;
  mutations: Record<string, BackendNamedSql>;
}

export interface NamedSqlExecutionContext {
  visitorId: string | null;
  ownerId: string;
  now: Date;
}

export interface ExecuteNamedSqlOptions {
  kind: "query" | "mutation";
  name: string;
  dbPath: string;
  body: unknown;
  context: NamedSqlExecutionContext;
  queue?: {
    bypass?: boolean;
    timeoutMs?: number;
  };
  resultBudget?: Partial<NamedSqlResultBudget>;
  onQueueWait?: (info: { dbPath: string; waitMs: number }) => void;
}

export interface NamedSqlResultBudget {
  maxRows: number;
  maxBytes: number;
}

export interface ExecuteNamedSqlTransactionOptions {
  dbPath: string;
  context: NamedSqlExecutionContext;
  body?: unknown;
  mutations?: Array<{
    name: string;
    body: unknown;
  }>;
  queue?: {
    timeoutMs?: number;
  };
  onQueueWait?: (info: { dbPath: string; waitMs: number }) => void;
}

export interface ValidateBackendContractOptions {
  dbPath?: string;
  requireSecurity?: boolean;
}

export interface LoadBackendContractOptions {
  allowDisabledHostedActions?: boolean;
}

export type NamedSqlExecutionResult =
  | { columns?: string[]; rows: Record<string, unknown>[] }
  | { changes?: number; lastInsertRowId?: number };

const BACKEND_SCHEMA_URLS = new Set([
  BACKEND_RESOURCE_SCHEMA_URL,
  BACKEND_QUERIES_SCHEMA_URL,
  BACKEND_MUTATIONS_SCHEMA_URL,
]);

const NAMED_SQL_SECURITY_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      required: ["mode", "template", "resource", "config", "digest"],
      additionalProperties: false,
      properties: {
        mode: { const: "generated" },
        template: { type: "string", minLength: 1 },
        resource: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        config: { type: "object" },
        digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    },
    {
      type: "object",
      required: ["mode", "access", "resources", "systemParams", "scenarios"],
      additionalProperties: false,
      properties: {
        mode: { const: "custom" },
        access: { enum: ["public", "authenticated", "owner", "owner-or-member"] },
        resources: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        },
        systemParams: { type: "array", items: { type: "string" } },
        scenarios: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            required: ["identity", "expect"],
            additionalProperties: false,
            properties: {
              identity: { enum: ["anonymous", "owner", "member"] },
              expect: { enum: ["allow", "deny"] },
            },
          },
        },
      },
    },
  ],
} as const;

const NAMED_SQL_ENTRY_JSON_SCHEMA = {
  type: "object",
  required: ["sql"],
  properties: {
    kind: { enum: ["query", "mutation"] },
    sql: { type: "string", minLength: 1 },
    params: { type: "object" },
    access: { enum: ["public", "authenticated", "owner", "acl"] },
    acl: { type: "array", items: { type: "string" } },
    result: { type: "object" },
    security: NAMED_SQL_SECURITY_JSON_SCHEMA,
  },
} as const;

export const BACKEND_JSON_SCHEMAS = {
  [BACKEND_RESOURCE_SCHEMA_URL]: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: BACKEND_RESOURCE_SCHEMA_URL,
    type: "object",
    required: ["$schema", "name"],
    additionalProperties: true,
    properties: {
      $schema: { const: BACKEND_RESOURCE_SCHEMA_URL },
      name: { type: "string", minLength: 1 },
      fields: { type: "object" },
      business: { type: "object" },
      routeAccess: { type: "object" },
    },
  },
  [BACKEND_QUERIES_SCHEMA_URL]: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: BACKEND_QUERIES_SCHEMA_URL,
    type: "object",
    required: ["$schema", "queries"],
    additionalProperties: false,
    properties: {
      $schema: { const: BACKEND_QUERIES_SCHEMA_URL },
      queries: { type: "object", additionalProperties: NAMED_SQL_ENTRY_JSON_SCHEMA },
    },
  },
  [BACKEND_MUTATIONS_SCHEMA_URL]: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: BACKEND_MUTATIONS_SCHEMA_URL,
    type: "object",
    required: ["$schema", "mutations"],
    additionalProperties: false,
    properties: {
      $schema: { const: BACKEND_MUTATIONS_SCHEMA_URL },
      mutations: { type: "object", additionalProperties: NAMED_SQL_ENTRY_JSON_SCHEMA },
    },
  },
} as const;

const SYSTEM_PARAM_NAMES = new Set<string>(PLATFORM_CAPABILITIES.backend.namedSql.systemParams);
const DEFAULT_NAMED_SQL_RESULT_BUDGET: NamedSqlResultBudget = {
  maxRows: PLATFORM_CAPABILITIES.backend.namedSql.maxRows,
  maxBytes: PLATFORM_CAPABILITIES.backend.namedSql.maxBytes,
};
const NAMED_SQL_PLATFORM_MAX_ROWS = PLATFORM_CAPABILITIES.backend.namedSql.maxRows;
const NAMED_SQL_PLATFORM_MAX_BYTES = PLATFORM_CAPABILITIES.backend.namedSql.maxBytes;

export function loadBackendContract(
  projectDir: string,
  config: BackendManifestConfig | undefined,
  options: LoadBackendContractOptions = {},
): BackendContract {
  if (!config) return emptyContract();
  rejectInlineBackendDefinitions(config);

  const files = discoverBackendFiles(projectDir, config, options);
  const contract = emptyContract();
  contract.files = files;

  for (const file of files) {
    if (file.kind === "unknown") continue;
    const value = readBackendJson(file);
    if (file.kind === "schema") {
      addResourceSchema(contract, file, value);
    } else if (file.kind === "queries") {
      addNamedSqlEntries(contract.queries, "query", file, value);
    } else if (file.kind === "mutations") {
      addNamedSqlEntries(contract.mutations, "mutation", file, value);
    }
  }

  return contract;
}

export function loadDefaultBackendContract(
  projectDir: string,
  options: LoadBackendContractOptions = {},
): BackendContract {
  return loadBackendContract(projectDir, { root: "backend" }, options);
}

export function validateBackendContract(contract: BackendContract, options: ValidateBackendContractOptions = {}): void {
  for (const [name, query] of Object.entries(contract.queries)) {
    if (options.requireSecurity && !query.security) {
      throw new Error(`Named SQL ${name} must declare security.mode as generated or custom`);
    }
    validateNamedSql(name, query, "query");
    validateSqlReferences(contract, name, query, options);
  }
  for (const [name, mutation] of Object.entries(contract.mutations)) {
    if (options.requireSecurity && !mutation.security) {
      throw new Error(`Named SQL ${name} must declare security.mode as generated or custom`);
    }
    validateNamedSql(name, mutation, "mutation");
    validateSqlReferences(contract, name, mutation, options);
  }
}

export async function executeNamedSql(
  contract: BackendContract,
  options: ExecuteNamedSqlOptions,
): Promise<NamedSqlExecutionResult> {
  const dbFile = resolveDbFile(options.dbPath);
  const execute = async () => executeNamedSqlUnsafe(contract, options, dbFile);
  if (options.queue?.bypass) return execute();
  return withDbQueue(dbFile, execute, {
    timeoutMs: options.queue?.timeoutMs,
    onWait: options.onQueueWait,
  });
}

export async function executeNamedSqlTransaction(
  contract: BackendContract,
  options: ExecuteNamedSqlTransactionOptions,
): Promise<NamedSqlExecutionResult[]> {
  const dbFile = resolveDbFile(options.dbPath);
  const mutations = normalizeNamedSqlTransactionRequest(options.body, options.mutations);
  return runDbTransaction(dbFile, async () => {
    const results: NamedSqlExecutionResult[] = [];
    for (const mutation of mutations) {
      results.push(await executeNamedSqlUnsafe(contract, {
        kind: "mutation",
        name: mutation.name,
        dbPath: options.dbPath,
        body: resolveTransactionResultRefs(mutation.body, results),
        context: options.context,
        queue: { bypass: true },
      }, dbFile));
    }
    return results;
  }, {
    timeoutMs: options.queue?.timeoutMs,
    onWait: options.onQueueWait,
  });
}

function resolveTransactionResultRefs(body: unknown, results: NamedSqlExecutionResult[]): unknown {
  if (!isRecord(body) || !isRecord(body.params)) return body;
  return {
    ...body,
    params: resolveTransactionParamValue(body.params, results),
  };
}

function resolveTransactionParamValue(value: unknown, results: NamedSqlExecutionResult[]): unknown {
  if (isTransactionResultRef(value)) {
    const index = value.$result;
    if (!Number.isInteger(index) || index < 0 || index >= results.length) {
      throw new Error(`Transaction result reference out of range: ${index}`);
    }
    const field = value.field;
    if (field !== "changes" && field !== "lastInsertRowId") {
      throw new Error(`Unsupported transaction result reference field: ${field}`);
    }
    const result = results[index] as Record<string, unknown>;
    if (!(field in result) || result[field] === undefined) {
      throw new Error(`Transaction result ${index} does not include field: ${field}`);
    }
    return result[field];
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTransactionParamValue(item, results));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTransactionParamValue(item, results)]),
    );
  }
  return value;
}

function isTransactionResultRef(value: unknown): value is { $result: number; field: string } {
  return isRecord(value) && typeof value.$result === "number" && typeof value.field === "string";
}

function normalizeNamedSqlTransactionRequest(
  body: unknown,
  mutations: ExecuteNamedSqlTransactionOptions["mutations"],
): NonNullable<ExecuteNamedSqlTransactionOptions["mutations"]> {
  if (mutations) return mutations;
  if (!isRecord(body) || !Array.isArray(body.mutations)) {
    throw new Error("Named SQL transaction body must include mutations array");
  }
  return body.mutations.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) {
      throw new Error(`Named SQL transaction mutation at index ${index} must declare name`);
    }
    if ("sql" in item) {
      throw new Error("Named SQL transaction does not accept sql field");
    }
    return {
      name: item.name,
      body: "body" in item ? item.body : { params: isRecord(item.params) ? item.params : {} },
    };
  });
}

async function executeNamedSqlUnsafe(
  contract: BackendContract,
  options: ExecuteNamedSqlOptions,
  dbFile: string,
): Promise<NamedSqlExecutionResult> {
  let entry: BackendNamedSql;
  try {
    entry = resolveNamedSql(contract, options.kind, options.name);
    if (!checkAccess(entry.access ?? "authenticated", options.context.visitorId, options.context.ownerId, entry.acl)) {
      throw new Error("Access denied");
    }
    const request = normalizeNamedSqlRequest(options.body);
    const params = validateRequestParams(options.name, entry, request.params);
    const bound = bindSqlParams(entry.sql, params, options.context);
    await getConnection(dbFile);
    validateSqlReferences(contract, options.name, entry, { dbPath: dbFile });
    if (options.kind === "query") {
      const queryResult = execQuerySqlWithBudget(
        dbFile,
        bound.sql,
        bound.params,
        { sqlName: options.name, ...effectiveNamedSqlResultBudget(entry, options.resultBudget) },
      );
      return queryResult;
    }
    const result = execRawSql(dbFile, bound.sql, bound.params);
    return {
      changes: result.changes,
      lastInsertRowId: result.lastInsertRowId,
    };
  } catch (err) {
    if (err instanceof LocalAppRuntimeError) throw err;
    if (isWasmRuntimeError(err)) {
      throw wrapDatabaseRuntimeError(err, {
        operation: options.kind,
        sqlName: options.name,
        dbPath: dbFile,
      });
    }
    throw err;
  }
}

function effectiveNamedSqlResultBudget(
  entry: BackendNamedSql,
  budgetOptions: Partial<NamedSqlResultBudget> | undefined,
): NamedSqlResultBudget {
  const candidates = [
    DEFAULT_NAMED_SQL_RESULT_BUDGET,
    entry.result
      ? {
        maxRows: entry.result.maxRows ?? (entry.result.mode === "single" ? 1 : DEFAULT_NAMED_SQL_RESULT_BUDGET.maxRows),
        maxBytes: entry.result.maxBytes ?? DEFAULT_NAMED_SQL_RESULT_BUDGET.maxBytes,
      }
      : undefined,
    budgetOptions,
  ];
  return candidates.reduce<NamedSqlResultBudget>((budget, candidate) => ({
    maxRows: Math.min(budget.maxRows, candidate?.maxRows ?? budget.maxRows),
    maxBytes: Math.min(budget.maxBytes, candidate?.maxBytes ?? budget.maxBytes),
  }), { ...DEFAULT_NAMED_SQL_RESULT_BUDGET });
}

export function resolveNamedSql(contract: BackendContract, kind: "query" | "mutation", name: string): BackendNamedSql {
  const entry = kind === "query" ? contract.queries[name] : contract.mutations[name];
  if (!entry) {
    throw new Error(`Named SQL not found: ${name}`);
  }
  if (entry.kind !== kind) {
    throw new Error(`Named SQL ${name} is not a ${kind}`);
  }
  validateNamedSql(name, entry, kind);
  return entry;
}

function emptyContract(): BackendContract {
  return {
    files: [],
    resources: {},
    queries: {},
    mutations: {},
  };
}

function rejectInlineBackendDefinitions(config: BackendManifestConfig): void {
  if (config.queries || config.mutations || config.resources) {
    throw new Error("Inline backend SQL/schema definitions are not supported. Put them in backend contract files.");
  }
}

function discoverBackendFiles(
  projectDir: string,
  config: BackendManifestConfig,
  options: LoadBackendContractOptions,
): BackendContractFile[] {
  const relativePaths = config.include?.length
    ? discoverByInclude(projectDir, config.include)
    : discoverByRoot(projectDir, config.root ?? "backend");
  if (!options.allowDisabledHostedActions) {
    assertNoHostedActionFiles(relativePaths);
  }

  return relativePaths
    .filter((relativePath) => relativePath.endsWith(".json") && !isHostedActionFile(relativePath))
    .sort()
    .map((relativePath) => {
      const normalized = normalizePath(relativePath);
      return {
        absolutePath: path.join(projectDir, normalized),
        relativePath: normalized,
        schemaUrl: "",
        kind: kindFromPath(normalized),
      };
    });
}

export function assertNoHostedActionFiles(relativePaths: readonly string[]): void {
  const actionFile = relativePaths
    .map((relativePath) => normalizePath(relativePath))
    .find(isHostedActionFile);
  if (!actionFile) return;
  throw new Error(
    `Hosted actions are disabled in stable LocalApp backend contracts: ${actionFile}. ` +
    "Use named SQL, transaction mutation, or a platform primitive instead.",
  );
}

function isHostedActionFile(relativePath: string): boolean {
  return relativePath.endsWith("/actions.manifest.json")
    || relativePath.endsWith("/actions.bundle.mjs")
    || relativePath === "actions.manifest.json"
    || relativePath === "actions.bundle.mjs"
    || /(^|\/)actions\/.+\.(?:ts|tsx|js|mjs)$/.test(relativePath);
}

function discoverByRoot(projectDir: string, root: string): string[] {
  const rootPath = path.resolve(projectDir, root);
  if (!isInside(projectDir, rootPath)) {
    throw new Error(`backend.root must stay inside project directory: ${root}`);
  }
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`backend root does not exist: ${root}`);
  }
  return walkFiles(rootPath).map((filePath) => normalizePath(path.relative(projectDir, filePath)));
}

function discoverByInclude(projectDir: string, patterns: string[]): string[] {
  const allProjectFiles = walkFiles(projectDir).map((filePath) => normalizePath(path.relative(projectDir, filePath)));
  const matched = new Set<string>();

  for (const pattern of patterns) {
    const regex = globToRegExp(normalizePath(pattern));
    const patternMatches = allProjectFiles.filter((filePath) => regex.test(filePath));
    if (patternMatches.length === 0) {
      throw new Error(`backend.include pattern did not match any backend contract files: ${pattern}`);
    }
    for (const filePath of patternMatches) matched.add(filePath);
  }

  return Array.from(matched);
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

function readBackendJson(file: BackendContractFile): Record<string, unknown> {
  const raw = fs.readFileSync(file.absolutePath, "utf8");
  const value = JSON.parse(raw) as Record<string, unknown>;
  const schemaUrl = value.$schema;
  if (typeof schemaUrl !== "string" || !schemaUrl.trim()) {
    throw new Error(`Backend contract file must declare $schema: ${file.relativePath}`);
  }
  if (!BACKEND_SCHEMA_URLS.has(schemaUrl)) {
    throw new Error(`Unsupported backend $schema in ${file.relativePath}: ${schemaUrl}`);
  }
  file.schemaUrl = schemaUrl;
  return value;
}

function addResourceSchema(contract: BackendContract, file: BackendContractFile, value: Record<string, unknown>): void {
  if (file.schemaUrl !== BACKEND_RESOURCE_SCHEMA_URL) {
    throw new Error(`Resource schema file uses the wrong $schema: ${file.relativePath}`);
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`Resource schema must declare name: ${file.relativePath}`);
  }
  if (value.fields !== undefined && !isRecord(value.fields)) {
    throw new Error(`Resource schema must declare fields: ${file.relativePath}`);
  }
  if (contract.resources[value.name]) {
    throw new Error(`Duplicate resource schema name: ${value.name}`);
  }
  const schema = { ...value, fields: isRecord(value.fields) ? value.fields : {} };
  contract.resources[value.name] = {
    schema: schema as unknown as BackendResourceSchema,
    schemaFile: file,
  };
}

function addNamedSqlEntries(
  target: Record<string, BackendNamedSql>,
  expectedKind: "query" | "mutation",
  file: BackendContractFile,
  value: Record<string, unknown>,
): void {
  const containerName = expectedKind === "query" ? "queries" : "mutations";
  const expectedSchema = expectedKind === "query" ? BACKEND_QUERIES_SCHEMA_URL : BACKEND_MUTATIONS_SCHEMA_URL;
  if (file.schemaUrl !== expectedSchema) {
    throw new Error(`${containerName} file uses the wrong $schema: ${file.relativePath}`);
  }
  if (!isRecord(value[containerName])) {
    throw new Error(`${containerName} file must declare ${containerName}: ${file.relativePath}`);
  }
  for (const [name, rawEntry] of Object.entries(value[containerName])) {
    if (!isRecord(rawEntry)) {
      throw new Error(`Named SQL entry must be an object: ${name}`);
    }
    if (target[name]) {
      throw new Error(`Duplicate named SQL entry: ${name}`);
    }
    const kind = rawEntry.kind ?? expectedKind;
    if (kind !== expectedKind) {
      throw new Error(`Named SQL ${name} must have kind ${expectedKind}`);
    }
    if (typeof rawEntry.sql !== "string" || !rawEntry.sql.trim()) {
      throw new Error(`Named SQL ${name} must declare sql`);
    }
    const params = rawEntry.params === undefined ? {} : rawEntry.params;
    if (!isRecord(params)) {
      throw new Error(`Named SQL ${name} params must be an object`);
    }
    const access = isAccessLevel(rawEntry.access) ? rawEntry.access : undefined;
    target[name] = {
      kind: expectedKind,
      sql: rawEntry.sql,
      params: params as Record<string, BackendNamedSqlParam>,
      access,
      acl: parseAcl(rawEntry.acl, name),
      result: expectedKind === "query" ? parseNamedSqlResult(rawEntry.result, name) : undefined,
      security: parseNamedSqlSecurity(rawEntry.security, {
        name,
        kind: expectedKind,
        sql: rawEntry.sql,
        access,
      }),
      file,
    };
  }
}

export function createGeneratedNamedSqlSecurity(input: {
  name: string;
  kind: "query" | "mutation";
  sql: string;
  template: string;
  resource: string;
  config: Record<string, unknown>;
}): BackendGeneratedNamedSqlSecurity {
  const unsigned = {
    mode: "generated" as const,
    template: input.template,
    resource: input.resource,
    config: input.config,
  };
  return {
    ...unsigned,
    digest: generatedSecurityDigest(input.name, input.kind, input.sql, unsigned),
  };
}

function parseNamedSqlSecurity(
  value: unknown,
  input: {
    name: string;
    kind: "query" | "mutation";
    sql: string;
    access: BackendAccessLevel | undefined;
  },
): BackendNamedSqlSecurity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Named SQL ${input.name} security must be an object`);
  if (value.mode === "generated") return parseGeneratedSecurity(value, input);
  if (value.mode === "custom") return parseCustomSecurity(value, input);
  throw new Error(`Named SQL ${input.name} security.mode must be generated or custom`);
}

function parseGeneratedSecurity(
  value: Record<string, unknown>,
  input: {
    name: string;
    kind: "query" | "mutation";
    sql: string;
    access: BackendAccessLevel | undefined;
  },
): BackendGeneratedNamedSqlSecurity {
  const template = requiredSecurityString(value, "template", input.name);
  const resource = requiredSecurityIdentifier(value, "resource", input.name);
  if (!isRecord(value.config)) {
    throw new Error(`Named SQL ${input.name} generated security must declare config`);
  }
  const digest = requiredSecurityString(value, "digest", input.name);
  const unsigned = { mode: "generated" as const, template, resource, config: value.config };
  if (digest !== generatedSecurityDigest(input.name, input.kind, input.sql, unsigned)) {
    throw new Error(
      `Named SQL ${input.name} generated security digest does not match its SQL or template metadata`,
    );
  }
  validateGeneratedSecurityStructure(input.name, input.sql, input.access, template, resource, value.config);
  return { ...unsigned, digest };
}

function validateGeneratedSecurityStructure(
  name: string,
  sql: string,
  runtimeAccess: BackendAccessLevel | undefined,
  template: string,
  resource: string,
  config: Record<string, unknown>,
): void {
  const normalized = normalizeSecuritySql(sql);
  if (!containsSecurityIdentifier(normalized, resource)) {
    throw new Error(`Named SQL ${name} generated template does not reference resource ${resource}`);
  }
  if (template === "public-v1") {
    requireSecurityAccess(name, runtimeAccess, "public");
    return;
  }
  if (template === "authenticated-v1") {
    requireSecurityAccess(name, runtimeAccess, "authenticated");
    return;
  }
  if (/^(owner|member)-(read|create|update|delete)-v1$/.test(template)) {
    requireSecurityAccess(name, runtimeAccess, "authenticated");
    const identityField = requiredSecurityIdentifier(config, "identityField", name);
    requireSecuritySql(name, normalized, [identityField, ":currentuserid"]);
    const identityConstraint = `${identityField.toLowerCase()} = :currentuserid`;
    if (template.includes("read")) requireSecurityWhere(name, normalized, identityConstraint);
    if (template.includes("create")) {
      requireSecuritySql(name, normalized, ["insert into"]);
      const splitAt = [normalized.indexOf(" values "), normalized.indexOf(" select ")]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      if (splitAt === undefined
        || !normalized.slice(0, splitAt).includes(identityField.toLowerCase())
        || !normalized.slice(splitAt).includes(":currentuserid")) {
        throw new Error(
          `Named SQL ${name} generated create security must write currentUserId to ${identityField}`,
        );
      }
    }
    if (template.includes("update")) {
      requireSecuritySql(name, normalized, ["update"]);
      requireSecurityWhere(name, normalized, identityConstraint);
    }
    if (template.includes("delete")) {
      requireSecuritySql(name, normalized, ["delete from"]);
      requireSecurityWhere(name, normalized, identityConstraint);
    }
    return;
  }
  if (template === "parent-owner-v1") {
    requireSecurityAccess(name, runtimeAccess, "authenticated");
    requireSecuritySql(name, normalized, [
      "exists",
      requiredSecurityIdentifier(config, "parentResource", name),
      requiredSecurityIdentifier(config, "foreignKey", name),
      requiredSecurityIdentifier(config, "parentIdentityField", name),
      ":currentuserid",
    ]);
    requireSecurityWhere(name, normalized, "exists");
    return;
  }
  if (template === "transition-v1") {
    requireSecurityAccess(name, runtimeAccess, "authenticated");
    requireSecuritySql(name, normalized, ["update"]);
    const statusField = requiredSecurityIdentifier(config, "statusField", name).toLowerCase();
    const from = requiredSecurityString(config, "from", name).toLowerCase();
    const to = requiredSecurityString(config, "to", name).toLowerCase();
    const [, afterSet = ""] = normalized.split(" set ", 2);
    const [setClause, whereClause] = afterSet.split(" where ", 2);
    if (!setClause || !whereClause) {
      throw new Error(`Named SQL ${name} transition security must declare SET and WHERE`);
    }
    if (!setClause.includes(statusField) || !setClause.includes(to)) {
      throw new Error(`Named SQL ${name} transition security SET must write ${statusField} to ${to}`);
    }
    if (!whereClause.includes(statusField) || !whereClause.includes(from)) {
      throw new Error(`Named SQL ${name} transition security WHERE must require ${statusField} = ${from}`);
    }
    return;
  }
  throw new Error(`Named SQL ${name} uses unknown generated template ${template}`);
}

function parseCustomSecurity(
  value: Record<string, unknown>,
  input: { name: string; sql: string; access: BackendAccessLevel | undefined },
): BackendCustomNamedSqlSecurity {
  const access = requiredSecurityString(value, "access", input.name);
  if (!(["public", "authenticated", "owner", "owner-or-member"] as string[]).includes(access)) {
    throw new Error(`Named SQL ${input.name} custom security access is invalid`);
  }
  requireSecurityAccess(input.name, input.access, access === "public" ? "public" : "authenticated");
  const resources = requiredSecurityStringArray(value, "resources", input.name, false);
  const normalized = normalizeSecuritySql(input.sql);
  for (const resource of resources) {
    if (!isSecurityIdentifier(resource) || !containsSecurityIdentifier(normalized, resource)) {
      throw new Error(
        `Named SQL ${input.name} custom security resource ${resource} is invalid or absent from SQL`,
      );
    }
  }
  const systemParams = requiredSecurityStringArray(value, "systemParams", input.name, true);
  const supported = new Set<string>(PLATFORM_CAPABILITIES.backend.namedSql.systemParams);
  if (systemParams.some((param) => !supported.has(param))) {
    throw new Error(`Named SQL ${input.name} custom security declares an unsupported system param`);
  }
  const used = [...supported]
    .filter((param) => normalized.includes(`:${param.toLowerCase()}`))
    .sort();
  if (JSON.stringify([...systemParams].sort()) !== JSON.stringify(used)) {
    throw new Error(
      `Named SQL ${input.name} custom security systemParams must exactly match trusted params used by SQL`,
    );
  }
  if (!Array.isArray(value.scenarios)) {
    throw new Error(`Named SQL ${input.name} custom security must declare scenarios`);
  }
  const scenarios = value.scenarios.map((scenario) => {
    if (!isRecord(scenario)) {
      throw new Error(`Named SQL ${input.name} custom security scenario must be an object`);
    }
    const identity = requiredSecurityString(scenario, "identity", input.name);
    const expect = requiredSecurityString(scenario, "expect", input.name);
    if (!(["anonymous", "owner", "member"] as string[]).includes(identity)
      || !(["allow", "deny"] as string[]).includes(expect)) {
      throw new Error(`Named SQL ${input.name} custom security scenario is invalid`);
    }
    return { identity, expect } as BackendCustomNamedSqlSecurity["scenarios"][number];
  });
  const identities = new Set(scenarios.map((scenario) => scenario.identity));
  for (const identity of ["owner", "member"] as const) {
    if (!identities.has(identity)) {
      throw new Error(
        `Named SQL ${input.name} custom security must cover the ${identity} identity scenario`,
      );
    }
  }
  return {
    mode: "custom",
    access: access as BackendCustomNamedSqlSecurity["access"],
    resources,
    systemParams,
    scenarios,
  };
}

function generatedSecurityDigest(
  name: string,
  kind: "query" | "mutation",
  sql: string,
  security: Omit<BackendGeneratedNamedSqlSecurity, "digest">,
): string {
  const payload = { name, kind, sql: normalizeSecuritySql(sql), security };
  return `sha256:${createHash("sha256").update(canonicalSecurityJson(payload)).digest("hex")}`;
}

function canonicalSecurityJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSecurityJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSecurityJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSecuritySql(sql: string): string {
  return sql.trim().split(/\s+/).join(" ").toLowerCase();
}

function requireSecurityAccess(
  name: string,
  actual: BackendAccessLevel | undefined,
  expected: BackendAccessLevel,
): void {
  if (actual !== expected) {
    throw new Error(`Named SQL ${name} security requires runtime access ${expected}`);
  }
}

function requireSecuritySql(name: string, sql: string, fragments: string[]): void {
  const missing = fragments.find((fragment) => !sql.includes(fragment.toLowerCase()));
  if (missing) {
    throw new Error(`Named SQL ${name} generated security SQL must contain ${missing}`);
  }
}

function requireSecurityWhere(name: string, sql: string, constraint: string): void {
  const whereClause = sql.split(" where ", 2)[1];
  if (!whereClause) throw new Error(`Named SQL ${name} generated security must declare WHERE`);
  if (!whereClause.includes(constraint.toLowerCase())) {
    throw new Error(`Named SQL ${name} generated security WHERE must contain ${constraint}`);
  }
}

function requiredSecurityString(object: Record<string, unknown>, field: string, name: string): string {
  const value = object[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Named SQL ${name} security must declare ${field}`);
  }
  return value;
}

function requiredSecurityIdentifier(
  object: Record<string, unknown>,
  field: string,
  name: string,
): string {
  const value = requiredSecurityString(object, field, name);
  if (!isSecurityIdentifier(value)) {
    throw new Error(`Named SQL ${name} security ${field} must be a SQL identifier`);
  }
  return value;
}

function requiredSecurityStringArray(
  object: Record<string, unknown>,
  field: string,
  name: string,
  allowEmpty: boolean,
): string[] {
  const value = object[field];
  if (!Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Named SQL ${name} security must declare ${field} as an array of strings`);
  }
  return value as string[];
}

function isSecurityIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function containsSecurityIdentifier(sql: string, identifier: string): boolean {
  return sql.split(/[^A-Za-z0-9_]+/).includes(identifier.toLowerCase());
}

function parseNamedSqlResult(value: unknown, name: string): BackendNamedSqlResult | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Named SQL ${name} result must be an object`);
  const mode = value.mode;
  if (mode !== "page" && mode !== "single" && mode !== "aggregate" && mode !== "bounded") {
    throw new Error(`Named SQL ${name} result.mode must be page, single, aggregate or bounded`);
  }
  const maxRows = parsePositiveInteger(value.maxRows, `Named SQL ${name} result.maxRows`);
  const maxBytes = parsePositiveInteger(value.maxBytes, `Named SQL ${name} result.maxBytes`);
  return { mode, maxRows, maxBytes };
}

function parsePositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseAcl(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Named SQL ${name} acl must be an array of non-empty strings`);
  }
  return value;
}

function validateNamedSql(name: string, entry: BackendNamedSql, expectedKind: "query" | "mutation"): void {
  const params = entry.params ?? {};
  for (const paramName of Object.keys(params)) {
    if (SYSTEM_PARAM_NAMES.has(paramName)) {
      throw new Error(`Named SQL ${name} params cannot redeclare system param ${paramName}`);
    }
  }

  const placeholders = extractSqlParams(entry.sql);
  const userPlaceholders = new Set(Array.from(placeholders).filter((paramName) => !SYSTEM_PARAM_NAMES.has(paramName)));
  const declaredParams = new Set(Object.keys(params));
  const missingDeclarations = Array.from(userPlaceholders).filter((paramName) => !declaredParams.has(paramName));
  const unusedDeclarations = Array.from(declaredParams).filter((paramName) => !userPlaceholders.has(paramName));
  if (missingDeclarations.length > 0 || unusedDeclarations.length > 0) {
    throw new Error(
      `Named SQL ${name} params mismatch. Missing declarations: ${missingDeclarations.join(", ") || "none"}; unused declarations: ${unusedDeclarations.join(", ") || "none"}`,
    );
  }

  assertSqlSafety(name, entry.sql, expectedKind);
  if (expectedKind === "query" && entry.result) validateNamedSqlResultContract(name, entry);
}

export function isBoundedNamedQuery(name: string, entry: BackendNamedSql): boolean {
  if (entry.kind !== "query" || !entry.result) return false;
  try {
    validateNamedSqlResultContract(name, entry);
    return true;
  } catch {
    return false;
  }
}

function validateNamedSqlResultContract(name: string, entry: BackendNamedSql): void {
  const result = entry.result;
  if (!result) return;
  const maxRows = result.maxRows ?? (result.mode === "single" ? 1 : undefined);
  const maxBytes = result.maxBytes ?? NAMED_SQL_PLATFORM_MAX_BYTES;
  if (!maxRows || maxRows > NAMED_SQL_PLATFORM_MAX_ROWS) {
    throw new Error(`Named SQL ${name} result maxRows must be <= ${NAMED_SQL_PLATFORM_MAX_ROWS}`);
  }
  if (maxBytes > NAMED_SQL_PLATFORM_MAX_BYTES) {
    throw new Error(`Named SQL ${name} result maxBytes must be <= ${NAMED_SQL_PLATFORM_MAX_BYTES}`);
  }
  if (result.mode === "single" && maxRows > 1) {
    throw new Error(`Named SQL ${name} single result must allow at most one row`);
  }
  if (result.mode === "page") {
    const params = entry.params ?? {};
    if (!params.limit || params.limit.type !== "number") {
      throw new Error(`Named SQL ${name} page result must declare numeric limit param`);
    }
    if (!/\bLIMIT\b/i.test(stripStringLiterals(stripLeadingSqlComments(entry.sql)))) {
      throw new Error(`Named SQL ${name} page result SQL must include LIMIT`);
    }
  }
}

function normalizeNamedSqlRequest(body: unknown): { params: Record<string, unknown> } {
  if (!isRecord(body)) {
    return { params: {} };
  }
  if ("sql" in body) {
    throw new Error("Named SQL request must not include sql field");
  }
  if (body.params === undefined) {
    return { params: {} };
  }
  if (!isRecord(body.params)) {
    throw new Error("Named SQL params must be an object");
  }
  return { params: body.params };
}

function validateRequestParams(
  name: string,
  entry: BackendNamedSql,
  requestParams: Record<string, unknown>,
): Record<string, unknown> {
  const paramSchemas = entry.params ?? {};
  for (const paramName of Object.keys(requestParams)) {
    if (SYSTEM_PARAM_NAMES.has(paramName)) {
      throw new Error(`Named SQL request cannot override system param ${paramName}`);
    }
    if (!paramSchemas[paramName]) {
      throw new Error(`Unknown param for named SQL ${name}: ${paramName}`);
    }
  }
  for (const [paramName, schema] of Object.entries(paramSchemas)) {
    const value = requestParams[paramName];
    if (schema.required && value === undefined) {
      throw new Error(`Missing required param for named SQL ${name}: ${paramName}`);
    }
    if (value === null && !schema.nullable) {
      throw new Error(`Param ${paramName} in named SQL ${name} must not be null`);
    }
    if (value !== undefined) {
      validateParamValue(name, paramName, schema, value);
    }
  }
  return requestParams;
}

function validateParamValue(name: string, paramName: string, schema: BackendNamedSqlParam, value: unknown): void {
  if (value === null && schema.nullable) {
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`Invalid value for param ${paramName} in named SQL ${name}`);
  }
  if (schema.type === "string" && typeof value !== "string") {
    throw new Error(`Param ${paramName} in named SQL ${name} must be a string`);
  }
  if (schema.type === "number" && typeof value !== "number") {
    throw new Error(`Param ${paramName} in named SQL ${name} must be a number`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`Param ${paramName} in named SQL ${name} must be a boolean`);
  }
}

function bindSqlParams(
  sql: string,
  requestParams: Record<string, unknown>,
  context: NamedSqlExecutionContext,
): { sql: string; params: unknown[] } {
  const systemParams: Record<string, unknown> = {
    currentUserId: context.visitorId,
    ownerId: context.ownerId,
    now: context.now.toISOString(),
  };
  const values: unknown[] = [];
  const preparedSql = sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_full, paramName: string) => {
    const value = SYSTEM_PARAM_NAMES.has(paramName) ? systemParams[paramName] : requestParams[paramName];
    values.push(value === undefined ? null : value);
    return "?";
  });
  return { sql: preparedSql, params: values };
}

function resolveDbFile(dbPath: string): string {
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory()) {
    return getDbPath(dbPath);
  }
  return dbPath;
}

function assertSqlSafety(name: string, sql: string, kind: "query" | "mutation"): void {
  const statements = sql.split(";").map((part) => part.trim()).filter(Boolean);
  if (statements.length !== 1) {
    throw new Error(`Unsafe ${kind} SQL in ${name}: multiple statements are not allowed`);
  }

  const normalized = stripLeadingSqlComments(statements[0]).trim().toUpperCase();
  if (kind === "query") {
    if (!normalized.startsWith("SELECT ") && !normalized.startsWith("WITH ")) {
      throw new Error(`Unsafe query SQL in ${name}: only SELECT/WITH statements are allowed`);
    }
    if (/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA)\b/i.test(normalized)) {
      throw new Error(`Unsafe query SQL in ${name}: write or DDL keywords are not allowed`);
    }
    return;
  }

  if (/\b(?:CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA)\b/i.test(normalized)) {
    throw new Error(`Unsafe mutation SQL in ${name}: DDL and database control statements are not allowed`);
  }
}

function validateSqlReferences(
  contract: BackendContract,
  name: string,
  entry: BackendNamedSql,
  options: ValidateBackendContractOptions = {},
): void {
  const knownResources = options.dbPath
    ? tableNamesForDb(options.dbPath)
    : new Set(Object.keys(contract.resources));
  if (knownResources.size === 0) return;

  const sql = stripStringLiterals(stripLeadingSqlComments(entry.sql));
  const cteNames = extractCteNames(sql);
  const tableNames = extractSqlTableNames(sql);
  for (const tableName of tableNames) {
    if (cteNames.has(tableName)) continue;
    if (tableName.startsWith("_")) {
      throw new Error(`Named SQL ${name} references a platform-owned system table: ${tableName}`);
    }
    if (!knownResources.has(tableName)) {
      throw new Error(`Named SQL ${name} references unknown resource: ${tableName}`);
    }
  }

  const primaryTable = tableNames.find((tableName) => knownResources.has(tableName));
  if (!primaryTable) return;
  const knownFields = fieldsForSqlReferences(contract, tableNames, options);
  for (const fieldName of extractSqlFieldNames(sql)) {
    if (!knownFields.has(fieldName)) {
      throw new Error(`Named SQL ${name} references unknown field ${primaryTable}.${fieldName}`);
    }
  }
}

function fieldsForSqlReferences(
  contract: BackendContract,
  tableNames: string[],
  options: ValidateBackendContractOptions,
): Set<string> {
  if (options.dbPath) {
    const fields = new Set<string>();
    for (const tableName of tableNames) {
      for (const field of fieldsForDbTable(options.dbPath, tableName)) fields.add(field);
    }
    return fields;
  }
  const fields = new Set<string>();
  for (const tableName of tableNames) {
    const resource = contract.resources[tableName];
    if (!resource) continue;
    for (const field of Object.keys(resource.schema.fields ?? {})) fields.add(field);
    fields.add("id");
  }
  return fields;
}

function tableNamesForDb(dbPath: string): Set<string> {
  const result = execRawSql(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set((result.rows ?? []).map((row) => String(row.name)));
}

function fieldsForDbTable(dbPath: string, resource: string): Set<string> {
    const escaped = resource.replace(/"/g, '""');
    const result = execRawSql(dbPath, `PRAGMA table_info("${escaped}")`);
    return new Set((result.rows ?? []).map((row) => String(row.name)));
}

function extractSqlTableNames(sql: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /\bJOIN\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /\bUPDATE\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /\bINSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /\bDELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      names.add(match[1]);
    }
  }
  return Array.from(names);
}

function extractSqlFieldNames(sql: string): Set<string> {
  const names = new Set<string>();
  const selectColumns = /\bSELECT\s+([\s\S]+?)\s+FROM\b/i.exec(sql)?.[1];
  if (selectColumns) {
    for (const column of splitSqlList(selectColumns)) {
      const field = extractSimpleFieldReference(column);
      if (field) names.add(field);
    }
  }

  const insertColumns = /\bINSERT\s+INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/i.exec(sql)?.[1];
  if (insertColumns) {
    for (const column of splitSqlList(insertColumns)) {
      const field = extractSimpleFieldReference(column);
      if (field) names.add(field);
    }
  }

  const setColumns = /\bSET\s+([\s\S]+?)(?:\s+WHERE\b|$)/i.exec(sql)?.[1];
  if (setColumns) {
    for (const assignment of splitSqlList(setColumns)) {
      const field = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(assignment)?.[1];
      if (field) names.add(field);
    }
  }

  for (const clause of extractSqlClauses(sql)) {
    const regex = /(?:^|[^:.])\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\b\s*(?:=|<>|!=|<|>|<=|>=|\bIN\b|\bLIKE\b|\bIS\b)/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clause)) !== null) {
      const field = match[1];
      if (!isSqlKeyword(field)) names.add(field);
    }
  }

  for (const clause of extractSqlListClauses(sql)) {
    for (const field of splitSqlList(clause)) {
      const simple = extractSimpleFieldReference(field);
      if (simple) names.add(simple);
    }
  }

  return names;
}

function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  if (!/^\s*WITH\b/i.test(sql)) return names;
  const regex = /\bWITH\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\b|,\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    names.add(match[1] ?? match[2]);
  }
  return names;
}

function extractSqlClauses(sql: string): string[] {
  const clauses: string[] = [];
  const patterns = [
    /\bWHERE\s+([\s\S]+?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|$)/gi,
    /\bGROUP\s+BY\s+([\s\S]+?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|$)/gi,
    /\bORDER\s+BY\s+([\s\S]+?)(?:\bLIMIT\b|\bOFFSET\b|$)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      clauses.push(match[1]);
    }
  }
  return clauses;
}

function extractSqlListClauses(sql: string): string[] {
  const clauses: string[] = [];
  const patterns = [
    /\bGROUP\s+BY\s+([\s\S]+?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|$)/gi,
    /\bORDER\s+BY\s+([\s\S]+?)(?:\bLIMIT\b|\bOFFSET\b|$)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      clauses.push(match[1]);
    }
  }
  return clauses;
}

function extractSimpleFieldReference(fragment: string): string | null {
  const normalized = fragment.trim();
  if (!normalized || normalized === "*" || normalized.endsWith(".*") || normalized.includes("(")) return null;
  const withoutAlias = normalized.replace(/\s+AS\s+[A-Za-z_][A-Za-z0-9_]*$/i, "").replace(/\s+[A-Za-z_][A-Za-z0-9_]*$/, "");
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(withoutAlias.trim());
  if (!match || isSqlKeyword(match[1])) return null;
  return match[1];
}

function splitSqlList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'([^']|'')*'/g, "''").replace(/"([^"]|"")*"/g, '""');
}

function isSqlKeyword(value: string): boolean {
  return /^(AND|OR|NOT|NULL|TRUE|FALSE|IS|IN|LIKE|BETWEEN|CASE|WHEN|THEN|ELSE|END|ASC|DESC|COUNT|LIMIT|OFFSET)$/i.test(value);
}

function extractSqlParams(sql: string): Set<string> {
  const names = new Set<string>();
  const regex = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function kindFromPath(relativePath: string): BackendContractFile["kind"] {
  const basename = path.posix.basename(relativePath);
  if (basename === "schema.json") return "schema";
  if (basename === "queries.json") return "queries";
  if (basename === "mutations.json") return "mutations";
  return "unknown";
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function stripLeadingSqlComments(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, "").replace(/^\s*\/\*[\s\S]*?\*\//, "");
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAccessLevel(value: unknown): value is AccessLevel {
  return value === "public" || value === "authenticated" || value === "owner" || value === "acl";
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
