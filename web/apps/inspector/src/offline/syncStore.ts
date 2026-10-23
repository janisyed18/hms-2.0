import type { SyncBootstrapResponse, SyncRecordRead, SyncWorkContext } from "../domain/types";

/**
 * The Inspector's persistent assigned-work store (IndexedDB), separate from the outbox.
 *
 * Three kinds of data, all keyed by user + device + sync protocol + storage schema, so
 * one user (or one device registration) can never load another's:
 *
 *  - `active`: the last fully reconciled snapshot. The offline source of truth.
 *  - `staging` + `chunks`: a bootstrap in progress. Each completed page (and, later,
 *    each page of reconciling changes) is one chunk, written in the same transaction as
 *    the progress record, so a crash leaves either the previous or the next
 *    consistent state.
 *
 * Promotion replaces `active` and removes the staging data in one transaction. Corrupt
 * entries are discarded on read; a corrupt staging entry never touches `active`.
 *
 * There is no encryption layer: a key stored beside the ciphertext would be theatre.
 * See docs/sync-bootstrap-paging.md for the threat model.
 */

export const SYNC_STORE_NAME = "hms-inspector-sync";
export const SYNC_STORE_VERSION = 1;
export const STORAGE_SCHEMA = 1;

export interface SyncScope {
  userId: string;
  deviceId: string;
  protocol: number;
}

export interface ActiveSnapshot {
  device: SyncBootstrapResponse["device"];
  cursor: number;
  records: SyncRecordRead[];
  workContexts: SyncWorkContext[];
  /** Absolute time (ms) after which the snapshot must not be used. */
  expiresAt: number;
  promotedAt: number;
}

export interface StagingProgress {
  snapshot: number;
  nextToken: string | null;
  pagesComplete: boolean;
  changesCursor: number;
  device: SyncBootstrapResponse["device"] | null;
  chunkCount: number;
  updatedAt: number;
}

export interface StagingChunk {
  kind: "page" | "changes";
  records: SyncRecordRead[];
  workContexts: SyncWorkContext[];
}

export interface StagingState {
  progress: StagingProgress;
  chunks: StagingChunk[];
}

export interface SyncStore {
  loadActive(scope: SyncScope): Promise<ActiveSnapshot | null>;
  loadStaging(scope: SyncScope): Promise<StagingState | null>;
  /** Replace any staging for the scope with an empty one. */
  beginStaging(scope: SyncScope, progress: StagingProgress): Promise<void>;
  /** One atomic write: the new chunk plus the updated progress. */
  appendStaging(
    scope: SyncScope,
    progress: StagingProgress,
    chunk: StagingChunk
  ): Promise<void>;
  /** Progress-only update (no new chunk). */
  saveProgress(scope: SyncScope, progress: StagingProgress): Promise<void>;
  discardStaging(scope: SyncScope): Promise<void>;
  /** Atomically make `snapshot` active and drop the staging data. */
  promote(scope: SyncScope, snapshot: ActiveSnapshot): Promise<void>;
  discardActive(scope: SyncScope): Promise<void>;
  /** Every active/staging entry of a user, on any device. Never the outbox. */
  clearUser(userId: string): Promise<void>;
}

export function scopeKey(scope: SyncScope): string {
  return JSON.stringify([scope.userId, scope.deviceId, scope.protocol, STORAGE_SCHEMA]);
}

function keyUser(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}

// --- shape checks: anything unexpected is treated as corruption -------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRecords(value: unknown): value is SyncRecordRead[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.entity === "string" &&
        typeof item.entity_id === "string" &&
        (item.op === "upsert" || item.op === "delete") &&
        typeof item.version === "number"
    )
  );
}

function validContexts(value: unknown): value is SyncWorkContext[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.appointment_id === "string" &&
        typeof item.booking_id === "string" &&
        typeof item.revision_id === "string" &&
        typeof item.assignment_id === "string" &&
        typeof item.asset_id === "string"
    )
  );
}

function validDevice(value: unknown): value is SyncBootstrapResponse["device"] {
  return (
    isRecord(value) &&
    typeof value.device_id === "string" &&
    typeof value.offline_window_days === "number" &&
    typeof value.revoked === "boolean"
  );
}

function validActive(value: unknown, key: string): value is ActiveSnapshot & { key: string } {
  return (
    isRecord(value) &&
    value.key === key &&
    validDevice(value.device) &&
    typeof value.cursor === "number" &&
    typeof value.expiresAt === "number" &&
    typeof value.promotedAt === "number" &&
    validRecords(value.records) &&
    validContexts(value.workContexts)
  );
}

function validProgress(value: unknown, key: string): value is StagingProgress & { key: string } {
  return (
    isRecord(value) &&
    value.key === key &&
    typeof value.snapshot === "number" &&
    (value.nextToken === null || typeof value.nextToken === "string") &&
    typeof value.pagesComplete === "boolean" &&
    typeof value.changesCursor === "number" &&
    (value.device === null || validDevice(value.device)) &&
    typeof value.chunkCount === "number" &&
    typeof value.updatedAt === "number"
  );
}

function validChunk(value: unknown): value is StagingChunk {
  return (
    isRecord(value) &&
    (value.kind === "page" || value.kind === "changes") &&
    validRecords(value.records) &&
    validContexts(value.workContexts)
  );
}

// --- IndexedDB --------------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function chunkRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
}

/** A store on `factory` (the browser's `indexedDB`, or a fake one in tests). */
export function createIndexedDbSyncStore(factory: IDBFactory): SyncStore {
  let opened: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (!opened) {
      opened = new Promise<IDBDatabase>((resolve, reject) => {
        const req = factory.open(SYNC_STORE_NAME, SYNC_STORE_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          // Version 1 is the first schema; nothing older exists to migrate. A future
          // version must handle (or deliberately discard) these stores here.
          for (const name of ["active", "staging"]) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: "key" });
            }
          }
          if (!db.objectStoreNames.contains("chunks")) {
            db.createObjectStore("chunks", { keyPath: ["key", "seq"] });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("Unable to open IndexedDB"));
        req.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
      }).catch((error: unknown) => {
        opened = null;
        throw error;
      });
    }
    return opened;
  }

  async function tx(stores: string[], mode: IDBTransactionMode) {
    const db = await open();
    const transaction = db.transaction(stores, mode);
    return { transaction, done: finished(transaction) };
  }

  async function removeStaging(transaction: IDBTransaction, key: string) {
    transaction.objectStore("staging").delete(key);
    transaction.objectStore("chunks").delete(chunkRange(key));
  }

  return {
    async loadActive(scope) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["active"], "readonly");
      const value: unknown = await request(transaction.objectStore("active").get(key));
      await done;
      if (value === undefined) return null;
      if (!validActive(value, key)) {
        await this.discardActive(scope);
        return null;
      }
      const { key: _key, ...snapshot } = value;
      void _key;
      return snapshot;
    },

    async loadStaging(scope) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["staging", "chunks"], "readonly");
      const progress: unknown = await request(transaction.objectStore("staging").get(key));
      const stored: unknown[] = await request(
        transaction.objectStore("chunks").getAll(chunkRange(key))
      );
      await done;
      if (progress === undefined) return null;
      const chunks = stored.map((item) => (isRecord(item) ? item.data : undefined));
      if (
        !validProgress(progress, key) ||
        chunks.length !== progress.chunkCount ||
        !chunks.every(validChunk)
      ) {
        await this.discardStaging(scope);
        return null;
      }
      const { key: _key, ...rest } = progress;
      void _key;
      return { progress: rest, chunks };
    },

    async beginStaging(scope, progress) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["staging", "chunks"], "readwrite");
      await removeStaging(transaction, key);
      transaction.objectStore("staging").put({ key, ...progress });
      await done;
    },

    async appendStaging(scope, progress, chunk) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["staging", "chunks"], "readwrite");
      transaction
        .objectStore("chunks")
        .put({ key, seq: progress.chunkCount - 1, data: chunk });
      transaction.objectStore("staging").put({ key, ...progress });
      await done;
    },

    async saveProgress(scope, progress) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["staging"], "readwrite");
      transaction.objectStore("staging").put({ key, ...progress });
      await done;
    },

    async discardStaging(scope) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["staging", "chunks"], "readwrite");
      await removeStaging(transaction, key);
      await done;
    },

    async promote(scope, snapshot) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["active", "staging", "chunks"], "readwrite");
      transaction.objectStore("active").put({ key, ...snapshot });
      await removeStaging(transaction, key);
      await done;
    },

    async discardActive(scope) {
      const key = scopeKey(scope);
      const { transaction, done } = await tx(["active"], "readwrite");
      transaction.objectStore("active").delete(key);
      await done;
    },

    async clearUser(userId) {
      const { transaction, done } = await tx(["active", "staging", "chunks"], "readwrite");
      for (const name of ["active", "staging"]) {
        const store = transaction.objectStore(name);
        const keys: IDBValidKey[] = await request(store.getAllKeys());
        for (const key of keys) {
          if (typeof key === "string" && keyUser(key) === userId) {
            store.delete(key);
          }
        }
      }
      const chunks = transaction.objectStore("chunks");
      const chunkKeys: IDBValidKey[] = await request(chunks.getAllKeys());
      for (const key of chunkKeys) {
        if (Array.isArray(key) && typeof key[0] === "string" && keyUser(key[0]) === userId) {
          chunks.delete(key);
        }
      }
      await done;
    }
  };
}

// --- in-memory fallback -----------------------------------------------------------

/** Used when IndexedDB is unavailable (blocked site data): same behaviour, no restart. */
export function createMemorySyncStore(): SyncStore {
  const active = new Map<string, ActiveSnapshot>();
  const staging = new Map<string, StagingState>();
  return {
    async loadActive(scope) {
      return active.get(scopeKey(scope)) ?? null;
    },
    async loadStaging(scope) {
      return staging.get(scopeKey(scope)) ?? null;
    },
    async beginStaging(scope, progress) {
      staging.set(scopeKey(scope), { progress, chunks: [] });
    },
    async appendStaging(scope, progress, chunk) {
      const current = staging.get(scopeKey(scope));
      staging.set(scopeKey(scope), {
        progress,
        chunks: [...(current?.chunks ?? []), chunk]
      });
    },
    async saveProgress(scope, progress) {
      const current = staging.get(scopeKey(scope));
      staging.set(scopeKey(scope), { progress, chunks: current?.chunks ?? [] });
    },
    async discardStaging(scope) {
      staging.delete(scopeKey(scope));
    },
    async promote(scope, snapshot) {
      active.set(scopeKey(scope), snapshot);
      staging.delete(scopeKey(scope));
    },
    async discardActive(scope) {
      active.delete(scopeKey(scope));
    },
    async clearUser(userId) {
      for (const map of [active, staging] as Array<Map<string, unknown>>) {
        for (const key of [...map.keys()]) {
          if (keyUser(key) === userId) map.delete(key);
        }
      }
    }
  };
}

let defaultStore: SyncStore | null = null;

/** The browser's IndexedDB store, or the in-memory fallback when it is unavailable. */
export function defaultSyncStore(): SyncStore {
  if (!defaultStore) {
    let factory: IDBFactory | null = null;
    try {
      factory = typeof indexedDB === "undefined" ? null : indexedDB;
    } catch {
      factory = null;
    }
    defaultStore = factory ? createIndexedDbSyncStore(factory) : createMemorySyncStore();
  }
  return defaultStore;
}

/** For tests: forget the cached default so the next call re-detects IndexedDB. */
export function resetDefaultSyncStore(): void {
  defaultStore = null;
}

/** Remove one user's assigned-work data (never their outbox). */
export function clearUserSyncData(userId: string, store: SyncStore = defaultSyncStore()) {
  return store.clearUser(userId);
}
