import path from "node:path";
import { AppDataError } from "./app-data-errors.cjs";
import { isCurrentDbQueueOwner, withDbQueue } from "./app-db.cjs";

const activeMaintenance = new Set<string>();
const reservedMaintenance = new Set<string>();
const activeObjectWrites = new Map<string, number>();
const objectWriteWaiters = new Map<string, Array<() => void>>();

function keyFor(pageDir: string): string {
  return path.resolve(pageDir);
}

export function isAppDataMaintenanceActive(pageDir: string): boolean {
  return activeMaintenance.has(keyFor(pageDir));
}

export function assertAppDataWritable(pageDir: string, ownsDatabaseQueue = false): void {
  const key = keyFor(pageDir);
  if (activeMaintenance.has(key) || (reservedMaintenance.has(key) && !ownsDatabaseQueue)) {
    throw new AppDataError("APP_DATA_MAINTENANCE", "Application data is temporarily read-only during maintenance");
  }
}

function waitForObjectWrites(key: string): Promise<void> {
  if ((activeObjectWrites.get(key) ?? 0) === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = objectWriteWaiters.get(key) ?? [];
    waiters.push(resolve);
    objectWriteWaiters.set(key, waiters);
  });
}

export async function withAppDataObjectWrite<T>(pageDir: string, operation: () => Promise<T>): Promise<T> {
  const key = keyFor(pageDir);
  if (reservedMaintenance.has(key) && !isCurrentDbQueueOwner(path.join(key, "app.db"))) {
    throw new AppDataError("APP_DATA_MAINTENANCE", "Application data is temporarily read-only during maintenance");
  }
  activeObjectWrites.set(key, (activeObjectWrites.get(key) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (activeObjectWrites.get(key) ?? 1) - 1;
    if (remaining > 0) activeObjectWrites.set(key, remaining);
    else {
      activeObjectWrites.delete(key);
      for (const resolve of objectWriteWaiters.get(key) ?? []) resolve();
      objectWriteWaiters.delete(key);
    }
  }
}

export async function withAppDataMaintenance<T>(pageDir: string, operation: () => Promise<T>): Promise<T> {
  const key = keyFor(pageDir);
  if (reservedMaintenance.has(key)) {
    throw new AppDataError("APP_DATA_OPERATION_BUSY", "Another data operation is already running");
  }
  reservedMaintenance.add(key);
  try {
    return await withDbQueue(path.join(key, "app.db"), async () => {
      await waitForObjectWrites(key);
      activeMaintenance.add(key);
      try {
        return await operation();
      } finally {
        activeMaintenance.delete(key);
      }
    }, { timeoutMs: 30_000 });
  } finally {
    reservedMaintenance.delete(key);
  }
}
