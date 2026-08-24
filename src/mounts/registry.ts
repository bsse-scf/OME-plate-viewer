/**
 * Mounted datasets.
 *
 * A "dataset" is a dropped CQ3000 folder together with the model parsed out of
 * it, exposed read-only under a random id. Both are stored in IndexedDB
 * because the service worker — not the page — is what ultimately reads the
 * bytes, and the browser can restart the worker at any time.
 */
import { idbDelete, idbGetAll, idbPut } from '../vfs/idb';
import { DATASET_STORE, MODEL_VERSION, type DatasetRecord } from '../vfs/protocol';
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
    version: MODEL_VERSION,
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
 * Drop datasets that cannot be reopened as they are.
 *
 * Two reasons. Handles survive a reload in IndexedDB but their permission grant
 * does not — re-granting requires a user gesture — so rather than leave the
 * user with a viewer that 403s on every chunk, forget them and ask for a fresh
 * drop. And a model built by an older version of this code carries derived
 * values, the display ranges above all, that the current version would not
 * produce; reusing it would quietly undo an update.
 *
 * Returns the number removed.
 */
export async function pruneUnreadableDatasets(): Promise<number> {
  let removed = 0;
  for (const dataset of await listDatasets()) {
    let usable = dataset.version === MODEL_VERSION;
    if (usable) {
      try {
        usable = (await dataset.handle.queryPermission({ mode: 'read' })) === 'granted';
      } catch {
        usable = false;
      }
    }
    if (!usable) {
      await idbDelete(DATASET_STORE, dataset.id);
      removed += 1;
    }
  }
  if (removed > 0) flushWorker();
  return removed;
}
