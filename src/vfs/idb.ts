/**
 * A minimal promise wrapper over IndexedDB.
 *
 * Deliberately dependency-free: this module is imported by both the page and
 * the service worker, and keeping it small keeps the worker bundle small.
 */
import { DATASET_STORE, DB_NAME, DB_VERSION } from './protocol';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DATASET_STORE)) {
        db.createObjectStore(DATASET_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return run<T | undefined>(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return run<T[]>(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function idbPut(store: string, value: unknown): Promise<void> {
  const db = await openDb();
  await run(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  await run(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}
