import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type PluginCombination = "multiuser" | "platform" | "full";
export interface ServerConfig {
  pluginCombination?: PluginCombination;
  documentsEnabled?: boolean;
  port: number;
  dataDir: string;
  listenHost: string;
  listenPort: number;
  publicUrl: string;
  workspaceDir: string;
  jwtKeyFile: string;
  masterKeyFile: string;
  allowInsecureLan: boolean;
  jwtSecret: string;
  bootstrapApiKey: string;
  templateRepoUrl: string;
  gitDownloadUrl: string;
  adminStaticDir: string;
  minCliVersion: string;
  releaseManifestUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmBaseUrl: string;
  minioEndpoint: string;
  minioAccessKey: string;
  minioSecretKey: string;
  minioBucket: string;
  adminDefaultPassword: string;
  appDataArchiveMaxBytes: number;
  appDataExpandedMaxBytes: number;
  appDataArchiveMaxFiles: number;
  deviceControlToken?: string;
  notificationControlToken?: string;
}

const DEFAULTS: ServerConfig = {
  port: 3000,
  dataDir: path.resolve(process.cwd(), ".localapp-server"),
  listenHost: "127.0.0.1",
  listenPort: 3000,
  publicUrl: "",
  workspaceDir: "workspaces",
  jwtKeyFile: "jwt.key",
  masterKeyFile: "master.key",
  allowInsecureLan: false,
  jwtSecret: "",
  bootstrapApiKey: "",
  templateRepoUrl: "",
  gitDownloadUrl: "",
  adminStaticDir: "",
  minCliVersion: "",
  releaseManifestUrl: "",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  llmBaseUrl: "https://api.openai.com/v1",
  minioEndpoint: "localhost:9000",
  minioAccessKey: "minioadmin",
  minioSecretKey: "minioadmin",
  minioBucket: "localapp-content",
  adminDefaultPassword: "localadmin",
  appDataArchiveMaxBytes: 2 * 1024 * 1024 * 1024,
  appDataExpandedMaxBytes: 4 * 1024 * 1024 * 1024,
  appDataArchiveMaxFiles: 10_000,
  deviceControlToken: "",
  notificationControlToken: "",
};

interface TomlConfigResult {
  values: Partial<ServerConfig>;
  hasDeprecatedRegistrationConfig: boolean;
}

export type PersistedServerSettings = Pick<ServerConfig,
  "listenHost" | "listenPort" | "publicUrl" | "workspaceDir" | "allowInsecureLan"
>;

export interface PendingNetworkSettings {
  previous: PersistedServerSettings | null;
  candidate: PersistedServerSettings;
}

const warnedDeprecatedConfigDirs = new Set<string>();
const JWT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const jwtRetryWait = new Int32Array(new SharedArrayBuffer(4));
const JWT_PUBLICATION_RETRIES = 25;
const UNSUPPORTED_HARD_LINK_CODES = new Set(["EOPNOTSUPP", "ENOTSUP", "EPERM", "EXDEV", "EINVAL"]);

async function readTomlConfig(dataDir: string): Promise<TomlConfigResult> {
  const tomlPath = path.join(dataDir, "config.toml");
  if (!fs.existsSync(tomlPath)) {
    return { values: {}, hasDeprecatedRegistrationConfig: false };
  }

  const content = fs.readFileSync(tomlPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    const TOML = await import("smol-toml");
    parsed = TOML.parse(content) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${tomlPath}: ${msg}`);
  }

  const result: Partial<ServerConfig> = {};
  const server = parsed.server as Record<string, unknown> | undefined;
  const auth = parsed.auth as Record<string, unknown> | undefined;
  const template = parsed.template as Record<string, unknown> | undefined;
  const admin = parsed.admin as Record<string, unknown> | undefined;
  const cli = parsed.cli as Record<string, unknown> | undefined;
  const llm = parsed.llm as Record<string, unknown> | undefined;
  const minio = parsed.minio as Record<string, unknown> | undefined;

  if (server?.port != null) result.port = Number(server.port);
  if (server?.app_data_archive_max_bytes != null) result.appDataArchiveMaxBytes = Number(server.app_data_archive_max_bytes);
  if (server?.app_data_expanded_max_bytes != null) result.appDataExpandedMaxBytes = Number(server.app_data_expanded_max_bytes);
  if (server?.app_data_archive_max_files != null) result.appDataArchiveMaxFiles = Number(server.app_data_archive_max_files);
  if (server?.data_dir != null) result.dataDir = String(server.data_dir);
  if (auth?.jwt_secret != null) result.jwtSecret = String(auth.jwt_secret);
  if (auth?.bootstrap_api_key != null) result.bootstrapApiKey = String(auth.bootstrap_api_key);
  if (auth?.admin_default_password != null) result.adminDefaultPassword = String(auth.admin_default_password);
  if (template?.repo_url != null) result.templateRepoUrl = String(template.repo_url);
  if (template?.git_download_url != null) result.gitDownloadUrl = String(template.git_download_url);
  if (admin?.static_dir != null) result.adminStaticDir = String(admin.static_dir);
  if (cli?.min_version != null) result.minCliVersion = String(cli.min_version);
  if (cli?.release_manifest_url != null) result.releaseManifestUrl = String(cli.release_manifest_url);
  if (llm?.api_key != null) result.llmApiKey = String(llm.api_key);
  if (llm?.model != null) result.llmModel = String(llm.model);
  if (llm?.base_url != null) result.llmBaseUrl = String(llm.base_url);
  if (minio?.endpoint != null) result.minioEndpoint = String(minio.endpoint);
  if (minio?.access_key != null) result.minioAccessKey = String(minio.access_key);
  if (minio?.secret_key != null) result.minioSecretKey = String(minio.secret_key);
  if (minio?.bucket != null) result.minioBucket = String(minio.bucket);

  return {
    values: result,
    hasDeprecatedRegistrationConfig:
      auth?.allow_register != null
      || auth?.registration_key != null
      || auth?.auto_register_pattern != null,
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`);
  }
}

function parsePersistedServerSettings(parsed: Record<string, unknown> | undefined): Partial<PersistedServerSettings> {
  if (!parsed) return {};
  const values: Partial<PersistedServerSettings> = {};
  if (typeof parsed.listenHost === "string") values.listenHost = parsed.listenHost;
  if (typeof parsed.listenPort === "number") values.listenPort = parsed.listenPort;
  if (typeof parsed.publicUrl === "string") values.publicUrl = parsed.publicUrl;
  if (typeof parsed.workspaceDir === "string") values.workspaceDir = parsed.workspaceDir;
  if (typeof parsed.allowInsecureLan === "boolean") values.allowInsecureLan = parsed.allowInsecureLan;
  return values;
}

export function readPersistedServerSettings(dataDir: string): Partial<PersistedServerSettings> {
  return parsePersistedServerSettings(readJsonFile(path.join(dataDir, "server.json")));
}

export function readPendingNetworkSettings(dataDir: string): PendingNetworkSettings | undefined {
  const parsed = readJsonFile(path.join(dataDir, "server.pending.json"));
  if (!parsed) return undefined;
  const candidate = parsePersistedServerSettings(parsed.candidate as Record<string, unknown> | undefined);
  if (Object.keys(candidate).length !== 5) throw new Error("Invalid pending network configuration");
  const previous = parsed.previous === null
    ? null
    : parsePersistedServerSettings(parsed.previous as Record<string, unknown> | undefined);
  if (previous !== null && Object.keys(previous).length !== 5) throw new Error("Invalid previous network configuration");
  return {
    previous: previous as PersistedServerSettings | null,
    candidate: candidate as PersistedServerSettings,
  };
}

function readSettingsForProcess(dataDir: string, usePending: boolean): Partial<PersistedServerSettings> {
  if (usePending) {
    const pending = readPendingNetworkSettings(dataDir);
    if (!pending) throw new Error("Pending network configuration is missing");
    return normalizePersistedWorkspace(dataDir, pending.candidate);
  }
  return normalizePersistedWorkspace(dataDir, readPersistedServerSettings(dataDir));
}

function normalizePersistedWorkspace(dataDir: string, settings: Partial<PersistedServerSettings>): Partial<PersistedServerSettings> {
  if (!settings.workspaceDir || !path.isAbsolute(settings.workspaceDir)) return settings;
  const relative = path.relative(path.resolve(dataDir), path.resolve(settings.workspaceDir));
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return { ...settings, workspaceDir: relative || "." };
  }
  return settings;
}

function pickEnv(env: NodeJS.ProcessEnv, key: string, tomlValue: string | undefined, defaultVal: string): string {
  const envVal = env[key];
  if (envVal !== undefined && envVal !== "") return envVal;
  if (tomlValue !== undefined && tomlValue !== "") return tomlValue;
  return defaultVal;
}

function pickPositiveInteger(env: NodeJS.ProcessEnv, key: string, tomlValue: number | undefined, defaultValue: number): number {
  const raw = env[key] !== undefined && env[key] !== "" ? Number(env[key]) : (tomlValue ?? defaultValue);
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error(`${key} must be a positive integer`);
  return raw;
}

function pickPort(env: NodeJS.ProcessEnv, persistedValue: number | undefined, tomlValue: number | undefined): number {
  const raw = env.LISTEN_PORT ?? env.PORT;
  if (raw !== undefined && raw !== "") {
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("LISTEN_PORT must be between 0 and 65535");
    return port;
  }
  return persistedValue ?? tomlValue ?? DEFAULTS.listenPort;
}

function resolveDataPath(dataDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(dataDir, candidate);
}

export function resolveWorkspaceDir(dataDir: string, candidate: string): string {
  if (path.isAbsolute(candidate)) throw new Error("workspaceDir must be relative to dataDir");
  const lexicalDataDir = path.resolve(dataDir);
  const resolved = path.resolve(lexicalDataDir, candidate);
  if (!isPathWithin(lexicalDataDir, resolved)) throw new Error("workspaceDir must stay within dataDir");

  fs.mkdirSync(lexicalDataDir, { recursive: true });
  const realDataDir = fs.realpathSync(lexicalDataDir);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!isPathWithin(realDataDir, fs.realpathSync(ancestor))) {
    throw new Error("workspaceDir real path must stay within dataDir");
  }
  return resolved;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function readOrCreateJwtSecret(jwtKeyFile: string): string {
  const directory = path.dirname(jwtKeyFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(jwtKeyFile)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const secret = randomBytes(32).toString("base64url");
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, secret);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (process.platform !== "win32") fs.chmodSync(temporaryPath, 0o600);
    try {
      fs.linkSync(temporaryPath, jwtKeyFile);
    } catch (error: unknown) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EEXIST") {
        fs.rmSync(temporaryPath, { force: true });
        return readCompleteJwtSecret(jwtKeyFile);
      }
      if (UNSUPPORTED_HARD_LINK_CODES.has(code ?? "")) {
        return publishJwtWithRenameFallback(temporaryPath, jwtKeyFile, secret);
      }
      throw error;
    }
    fs.unlinkSync(temporaryPath);
    syncDirectory(directory);
    return secret;
  } catch (error: unknown) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function publishJwtWithRenameFallback(temporaryPath: string, jwtKeyFile: string, secret: string): string {
  const directory = path.dirname(jwtKeyFile);
  const lockPath = `${jwtKeyFile}.lock`;
  let lockDescriptor: number | undefined;
  try {
    for (let attempt = 0; attempt < JWT_PUBLICATION_RETRIES; attempt += 1) {
      try {
        lockDescriptor = fs.openSync(lockPath, "wx", 0o600);
        break;
      } catch (error: unknown) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== "EEXIST") throw error;
        if (fs.existsSync(jwtKeyFile)) {
          fs.rmSync(temporaryPath, { force: true });
          return readCompleteJwtSecret(jwtKeyFile);
        }
        Atomics.wait(jwtRetryWait, 0, 0, 10);
      }
    }
    if (lockDescriptor === undefined) throw new Error(`JWT publication lock at ${lockPath} did not become available`);
    if (fs.existsSync(jwtKeyFile)) {
      fs.rmSync(temporaryPath, { force: true });
      return readCompleteJwtSecret(jwtKeyFile);
    }
    fs.renameSync(temporaryPath, jwtKeyFile);
    syncDirectory(directory);
    return secret;
  } finally {
    if (lockDescriptor !== undefined) {
      // Node has no atomic unlink-if-this-descriptor-still-owns-the-path operation.
      fs.closeSync(lockDescriptor);
    }
  }
}

function readCompleteJwtSecret(jwtKeyFile: string): string {
  for (let attempt = 0; attempt < JWT_PUBLICATION_RETRIES; attempt += 1) {
    try {
      const secret = fs.readFileSync(jwtKeyFile, "utf8").trim();
      if (JWT_SECRET_PATTERN.test(secret)) {
        if (process.platform !== "win32") fs.chmodSync(jwtKeyFile, 0o600);
        return secret;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    Atomics.wait(jwtRetryWait, 0, 0, 10);
  }
  throw new Error(`JWT key at ${jwtKeyFile} was not published completely`);
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (["EINVAL", "EPERM", "EISDIR"].includes(code ?? "")) return;
    console.warn("LocalApp JWT directory fsync failed after commit; continuing with committed key", error);
  }
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const dataDir = path.resolve(env.DATA_DIR || DEFAULTS.dataDir);
  const tomlResult = await readTomlConfig(dataDir);
  const toml = tomlResult.values;
  const persisted = readSettingsForProcess(dataDir, env.LOCALAPP_USE_PENDING_CONFIG === "1");
  const hasDeprecatedEnvironmentConfig = [
    "ALLOW_REGISTER",
    "REGISTRATION_KEY",
    "AUTO_REGISTER_PATTERN",
  ].some((key) => env[key] !== undefined);
  if (
    (tomlResult.hasDeprecatedRegistrationConfig || hasDeprecatedEnvironmentConfig)
    && !warnedDeprecatedConfigDirs.has(dataDir)
  ) {
    warnedDeprecatedConfigDirs.add(dataDir);
    console.warn(
      "deprecated registration configuration was ignored; provision users through the admin interface.",
    );
  }

  const listenPort = pickPort(env, persisted.listenPort, toml.port);
  const jwtKeyFile = resolveDataPath(dataDir, env.JWT_KEY_FILE || DEFAULTS.jwtKeyFile);
  const storedPlugins = readJsonFile(path.join(dataDir, "plugins.json"));
  const pluginCombination = env.LOCALAPP_PLUGIN_COMBINATION || storedPlugins?.combination || "full";
  if (storedPlugins?.documentsEnabled !== undefined && typeof storedPlugins.documentsEnabled !== "boolean") throw new Error("Invalid document extension setting");
  if (typeof pluginCombination !== "string" || !["multiuser", "platform", "full"].includes(pluginCombination)) throw new Error("Invalid LocalApp plugin combination");
  const config: ServerConfig = {
    pluginCombination: pluginCombination as PluginCombination,
    documentsEnabled: storedPlugins?.documentsEnabled !== false,
    port: listenPort,
    // dataDir is determined before reading config.toml — toml's data_dir must not override
    dataDir: dataDir,
    listenHost: pickEnv(env, "LISTEN_HOST", persisted.listenHost, DEFAULTS.listenHost),
    listenPort,
    publicUrl: pickEnv(env, "PUBLIC_URL", persisted.publicUrl, DEFAULTS.publicUrl),
    workspaceDir: resolveWorkspaceDir(dataDir, pickEnv(env, "WORKSPACE_DIR", persisted.workspaceDir, DEFAULTS.workspaceDir)),
    jwtKeyFile,
    masterKeyFile: resolveDataPath(dataDir, env.MASTER_KEY_FILE || DEFAULTS.masterKeyFile),
    allowInsecureLan: env.ALLOW_INSECURE_LAN === "true" || (env.ALLOW_INSECURE_LAN === undefined && (persisted.allowInsecureLan ?? DEFAULTS.allowInsecureLan)),
    jwtSecret: env.JWT_SECRET || toml.jwtSecret || readOrCreateJwtSecret(jwtKeyFile),
    bootstrapApiKey: pickEnv(env, "BOOTSTRAP_API_KEY", toml.bootstrapApiKey, DEFAULTS.bootstrapApiKey),
    templateRepoUrl: pickEnv(env, "TEMPLATE_REPO_URL", toml.templateRepoUrl, DEFAULTS.templateRepoUrl),
    gitDownloadUrl: pickEnv(env, "GIT_DOWNLOAD_URL", toml.gitDownloadUrl, DEFAULTS.gitDownloadUrl),
    adminStaticDir: pickEnv(env, "ADMIN_STATIC_DIR", toml.adminStaticDir, DEFAULTS.adminStaticDir),
    minCliVersion: pickEnv(env, "MIN_CLI_VERSION", toml.minCliVersion, DEFAULTS.minCliVersion),
    releaseManifestUrl: pickEnv(
      env,
      "LOCALAPP_RELEASE_MANIFEST_URL",
      toml.releaseManifestUrl,
      DEFAULTS.releaseManifestUrl,
    ),
    llmApiKey: pickEnv(env, "LLM_API_KEY", toml.llmApiKey, DEFAULTS.llmApiKey),
    llmModel: pickEnv(env, "LLM_MODEL", toml.llmModel, DEFAULTS.llmModel),
    llmBaseUrl: pickEnv(env, "LLM_BASE_URL", toml.llmBaseUrl, DEFAULTS.llmBaseUrl),
    minioEndpoint: pickEnv(env, "MINIO_ENDPOINT", toml.minioEndpoint, DEFAULTS.minioEndpoint),
    minioAccessKey: pickEnv(env, "MINIO_ACCESS_KEY", toml.minioAccessKey, DEFAULTS.minioAccessKey),
    minioSecretKey: pickEnv(env, "MINIO_SECRET_KEY", toml.minioSecretKey, DEFAULTS.minioSecretKey),
    minioBucket: pickEnv(env, "MINIO_BUCKET", toml.minioBucket, DEFAULTS.minioBucket),
    adminDefaultPassword: pickEnv(env, "ADMIN_DEFAULT_PASSWORD", toml.adminDefaultPassword, DEFAULTS.adminDefaultPassword),
    appDataArchiveMaxBytes: pickPositiveInteger(env, "APP_DATA_ARCHIVE_MAX_BYTES", toml.appDataArchiveMaxBytes, DEFAULTS.appDataArchiveMaxBytes),
    appDataExpandedMaxBytes: pickPositiveInteger(env, "APP_DATA_EXPANDED_MAX_BYTES", toml.appDataExpandedMaxBytes, DEFAULTS.appDataExpandedMaxBytes),
    appDataArchiveMaxFiles: pickPositiveInteger(env, "APP_DATA_ARCHIVE_MAX_FILES", toml.appDataArchiveMaxFiles, DEFAULTS.appDataArchiveMaxFiles),
    deviceControlToken: env.LOCALAPP_DEVICE_CONTROL_TOKEN ?? DEFAULTS.deviceControlToken,
    notificationControlToken: env.LOCALAPP_NOTIFICATION_CONTROL_TOKEN ?? DEFAULTS.notificationControlToken,
  };

  if (config.notificationControlToken && Buffer.byteLength(config.notificationControlToken, "utf8") < 16) {
    throw new Error("LOCALAPP_NOTIFICATION_CONTROL_TOKEN must contain at least 128 bits");
  }

  // TEMPLATE_REPO_URL is no longer mandatory at startup.
  // It is checked at point of use (template download handler) when remote cloning is requested.

  return config;
}
