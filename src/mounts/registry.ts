/**
 * Mounted datasets.
 *
 * A "dataset" is a dropped CQ3000 folder together with the model parsed out of
 * it, exposed read-only under a random id. Both are stored in IndexedDB
 * because the service worker — not the page — is what ultimately reads the
 * bytes, and the browser can restart the worker at any time.
 */
import { idbDelete, idbGetAll, idbPut } from '../vfs/idb';
import { DATASET_STORE, type DatasetRecord } from '../vfs/protocol';
import { flushWorker } from '../vfs/client';
import type { PlateModel } from '../yokogawa/types';

export type Dataset = DatasetRecord;

/**
 * Short, URL-safe, unguessable id. Unguessable matters a little: it is the
 * only thing separating one dataset's namespace from another's within the
 * origin, and it keeps ids from colliding across sessions.
 */
function newDatasetId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createDataset(
  handle: FileSystemDirectoryHandle,
  model: PlateModel,
): Promise<Dataset> {
  const dataset: Dataset = {
    id: newDatasetId(),
    name: handle.name,
    handle,
    model,
    createdAt: Date.now(),
  };
  await idbPut(DATASET_STORE, dataset);
  return dataset;
}

export async function listDatasets(): Promise<Dataset[]> {
  const datasets = await idbGetAll<Dataset>(DATASET_STORE);
  return datasets.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeDataset(datasetId: string): Promise<void> {
  await idbDelete(DATASET_STORE, datasetId);
  flushWorker(datasetId);
}

export async function removeAllDatasets(): Promise<void> {
  for (const dataset of await listDatasets()) {
    await idbDelete(DATASET_STORE, dataset.id);
  }
  flushWorker();
}

/**
 * Drop datasets whose read permission no longer holds.
 *
 * Handles survive a reload in IndexedDB but their permission grant does not:
 * re-granting requires a user gesture. Rather than leave the user with a
 * viewer that 403s on every chunk, forget them so the page can ask for a fresh
 * drop. Returns the number removed.
 */
export async function pruneUnreadableDatasets(): Promise<number> {
  let removed = 0;
  for (const dataset of await listDatasets()) {
    let state: PermissionState = 'granted';
    try {
      state = await dataset.handle.queryPermission({ mode: 'read' });
    } catch {
      state = 'denied';
    }
    if (state !== 'granted') {
      await idbDelete(DATASET_STORE, dataset.id);
      removed += 1;
    }
  }
  if (removed > 0) flushWorker();
  return removed;
}
