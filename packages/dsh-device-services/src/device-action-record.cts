import type { DeviceActionPermissionSet, DeviceActionStatus } from "@localapp/dsh-device-services/device-action-types";
export interface DeviceActionError {
  message: string;
  code?: string;
}

export interface DeviceActionRecord {
  id: string;
  userId: string;
  serverOrigin: string;
  appOwner: string;
  appName: string;
  appVersion: string | null;
  publisherUserId: string;
  publisherDisplayName: string | null;
  title: string;
  description: string | null;
  script: string;
  dependencies: Record<string, string>;
  input: unknown;
  timeoutSeconds: number;
  permissions: DeviceActionPermissionSet;
  permissionsDigest: string;
  nonce: string;
  installationId: string | null;
  status: DeviceActionStatus;
  result: unknown;
  error: DeviceActionError | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}
