export interface User {
  id: string;
  name: string;
  role?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
}

export interface Pagination {
  offset: number;
  limit: number;
  total: number;
}

export interface ListOptions {
  offset?: number;
  limit?: number;
  sort?: string;
  order?: string;
  filters?: Record<string, string | undefined>;
}

export interface ListResult<T> {
  rows: T[];
  pagination: Pagination;
}

export interface UserBasic {
  id: string;
  name: string;
  displayName: string | null;
}

export interface GroupBasic {
  id: string;
  name: string;
  description: string | null;
  isCreator: boolean;
}

export interface UploadResult {
  key: string;
  url: string;
}

export interface ServerTime {
  now: string;
  today: string;
}

export interface PlatformCapabilities {
  $schema: string;
  schemaVersion: number;
  platformVersion: string;
  content: {
    upload: {
      enabled: boolean;
      maxBytes: number;
      validatesFileSignature: boolean;
    };
    read: {
      enabled: boolean;
      rangeRequests: boolean;
      delete: boolean;
    };
    bundles?: { enabled: boolean; maxFiles: number; maxBytes: number; maxConcurrent: number; maxPending: number; retentionSeconds: number };
    types: Array<{
      extension: string;
      mimeType: string;
      inlinePreview: boolean;
    }>;
  };
  backend: {
    stableMode: "named-sql";
    namedSql: {
      enabled: boolean;
      transactions: boolean;
      maxRows: number;
      maxBytes: number;
      systemParams: Array<"currentUserId" | "ownerId" | "now">;
    };
    hostedActions: {
      enabled: boolean;
      stable: boolean;
    };
    securityContracts: {
      enabled: boolean;
      contractVersion: number;
      requiredFromPlatformVersion: string;
      generatedTemplates: string[];
      customScenarios: boolean;
    };
  };
  identity: {
    currentUser: boolean;
    pageOwner: boolean;
    groups: boolean;
  };
  verification: {
    enabled: boolean;
    isolatedDatabase: boolean;
    identities: Array<"owner" | "member">;
    defaultTtlSeconds: number;
    maxTtlSeconds: number;
    maxConcurrentSessions: number;
    maxDatabaseBytes: number;
  };
}
