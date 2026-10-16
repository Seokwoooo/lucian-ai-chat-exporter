// Extension-origin IndexedDB used as a bounded local cache (tech doc §29, §30.5):
//  - conversations: normalized conversations, expired after 7 days
//  - assets: fetched images / attachments as Blobs, LRU-capped at 500 entries
//  - handoffCache: per-conversation analysis cache for incremental handoff runs
// Nothing here ever leaves the browser. Auth tokens are never stored.

import type { Conversation } from './types';

const DB_NAME = 'lucianDB';
const DB_VERSION = 1;
export const RETENTION_DAYS = 7;
export const MAX_ASSETS = 500;

export interface ConversationRecord {
  key: string;
  savedAt: number;
  site: string;
  conversation: Conversation;
}

export interface AssetRecord {
  key: string;
  blob: Blob;
  mime: string;
  size: number;
  lastReadTime: number;
}

export interface HandoffCacheRecord {
  key: string;
  version: number;
  updatedAt: number;
  /** 53-bit unit keys (normalized text hashes). */
  keys: Float64Array;
  flags: Uint32Array;
  /** 1 when a MinHash signature is stored for the entry. */
  hasSig: Uint8Array;
  /** NUM_HASHES values per entry (zeros when hasSig is 0). */
  sigs: Uint32Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversations')) {
          const s = db.createObjectStore('conversations', { keyPath: 'key' });
          s.createIndex('savedAt', 'savedAt');
        }
        if (!db.objectStoreNames.contains('assets')) {
          const s = db.createObjectStore('assets', { keyPath: 'key' });
          s.createIndex('lastReadTime', 'lastReadTime');
        }
        if (!db.objectStoreNames.contains('handoffCache')) db.createObjectStore('handoffCache', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        let result: T;
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const conversationKey = (site: string, pageId: string) => `${site}:${pageId}`;

export function putConversation(conv: Conversation): Promise<string> {
  const key = conversationKey(conv.site, conv.pageId);
  const rec: ConversationRecord = { key, savedAt: Date.now(), site: conv.site, conversation: conv };
  return tx('conversations', 'readwrite', (s) => s.put(rec)).then(() => key);
}

export async function getConversation(key: string): Promise<Conversation | undefined> {
  const rec = await tx<ConversationRecord | undefined>('conversations', 'readonly', (s) => s.get(key));
  return rec?.conversation;
}

export async function putAsset(key: string, blob: Blob, mime: string): Promise<void> {
  await tx('assets', 'readwrite', (s) => s.put({ key, blob, mime, size: blob.size, lastReadTime: Date.now() } satisfies AssetRecord));
}

export async function getAsset(key: string): Promise<AssetRecord | undefined> {
  const rec = await tx<AssetRecord | undefined>('assets', 'readonly', (s) => s.get(key));
  if (rec) void tx('assets', 'readwrite', (s) => s.put({ ...rec, lastReadTime: Date.now() })).catch(() => undefined);
  return rec;
}

export function getHandoffCache(key: string): Promise<HandoffCacheRecord | undefined> {
  return tx<HandoffCacheRecord | undefined>('handoffCache', 'readonly', (s) => s.get(key));
}

export async function putHandoffCache(rec: HandoffCacheRecord): Promise<void> {
  await tx('handoffCache', 'readwrite', (s) => s.put(rec));
}

/**
 * Deletes conversations, handoff caches and cached images/attachments older than the retention
 * period, then trims the asset cache to MAX_ASSETS (tech doc §29.4, §30.5).
 */
export async function cleanupCaches(days = RETENTION_DAYS): Promise<{ conversations: number; assets: number }> {
  const db = await openDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const expired: string[] = await new Promise((resolve, reject) => {
    const keys: string[] = [];
    const t = db.transaction('conversations', 'readonly');
    const range = IDBKeyRange.upperBound(cutoff);
    const cur = t.objectStore('conversations').index('savedAt').openKeyCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        keys.push(String(c.primaryKey));
        c.continue();
      }
    };
    t.oncomplete = () => resolve(keys);
    t.onerror = () => reject(t.error);
  });
  if (expired.length) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(['conversations', 'handoffCache'], 'readwrite');
      for (const k of expired) {
        t.objectStore('conversations').delete(k);
        t.objectStore('handoffCache').delete(k);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  // Oldest first (lastReadTime index).
  const assets: Array<{ key: string; lastRead: number }> = await new Promise((resolve, reject) => {
    const rows: Array<{ key: string; lastRead: number }> = [];
    const t = db.transaction('assets', 'readonly');
    const cur = t.objectStore('assets').index('lastReadTime').openKeyCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        rows.push({ key: String(c.primaryKey), lastRead: Number(c.key) });
        c.continue();
      }
    };
    t.oncomplete = () => resolve(rows);
    t.onerror = () => reject(t.error);
  });
  const stale = assets.filter((a) => a.lastRead < cutoff).length;
  const remove = Math.max(stale, assets.length - MAX_ASSETS);
  if (remove > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('assets', 'readwrite');
      for (const a of assets.slice(0, remove)) t.objectStore('assets').delete(a.key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  return { conversations: expired.length, assets: remove };
}
