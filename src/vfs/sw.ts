/**
 * Service Worker hosting the virtual OME-Zarr namespace.
 *
 *   GET|HEAD <base>_zarr/<dataset-id>/<row>/<column>/0/0/<t>.<c>.<z>.<y>.<x>
 *
 * The page parses a dropped dataset into a model and stores it, with the
 * folder's handle, in IndexedDB. This worker reads that record and answers
 * Neuroglancer's requests by slicing the TIFF planes where they already sit.
 * Nothing is copied into browser storage and no image data is cached: the
 * three caches here hold a directory handle, a TIFF directory and a dataset
 * record, all of them small and all of them cheap to rebuild.
 *
 * The HTTP semantics live in `serve.ts`; what remains here is lifecycle,
 * storage lookup, caching and the concurrency bound.
 */
/// <reference lib="webworker" />
import { idbGet } from './idb';
import {
  DATASET_STORE,
  namespacePrefix,
  ZARR_SEGMENT,
  type DatasetRecord,
  type PortalMessage,
} from './protocol';
import { isNotFound, isTypeMismatch, openDatasetFile } from './files';
import { CHUNK_BUDGET_BYTES, createGate, MAX_CONCURRENT_CHUNKS } from './gate';
import { serveZarr } from './serve';
import { readPlaneLayout, type PlaneLayout } from '../yokogawa/tiff';

// `self` is typed as `Window` because the project's `lib` includes DOM; cast
// rather than redeclare so DOM types stay available to shared modules.
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * The path this worker controls, e.g. `/` or `/OME-plate-viewer/`.
 * Taking it from the registration scope rather than a build-time constant is
 * what lets one build be deployed at any subpath, GitHub Pages included.
 */
const BASE_PATH = new URL(sw.registration.scope).pathname;
const ZARR_PREFIX = namespacePrefix(BASE_PATH, ZARR_SEGMENT);

sw.addEventListener('install', () => {
  // Take over immediately: a freshly dropped folder should be readable without
  // the user having to reload the page first.
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  if (!url.pathname.startsWith(ZARR_PREFIX)) return;

  event.respondWith(
    serveZarr(event.request, url, {
      prefix: ZARR_PREFIX,
      lookupDataset: getDataset,
      openFile: (dataset, path) =>
        openDatasetFile(dataset.handle, path, (root, segments) =>
          resolveDirectoryCached(dataset.id, root, segments),
        ),
      planeLayout: getPlaneLayout,
      gate: gate.run,
    }),
  );
});

sw.addEventListener('message', (event) => {
  const message = event.data as PortalMessage | undefined;
  if (!message) return;

  if (message.type === 'ping') {
    event.source?.postMessage({ type: 'pong' });
  } else if (message.type === 'flush') {
    if (message.datasetId) {
      datasetCache.delete(message.datasetId);
      for (const key of [...directoryCache.keys()]) {
        if (key.startsWith(`${message.datasetId}/`)) directoryCache.delete(key);
      }
      for (const key of [...layoutCache.keys()]) {
        if (key.startsWith(`${message.datasetId}/`)) layoutCache.delete(key);
      }
    } else {
      datasetCache.clear();
      directoryCache.clear();
      layoutCache.clear();
    }
  }
});

/* ------------------------------------------------------------ persistence */

const datasetCache = new Map<string, DatasetRecord | null>();

async function getDataset(datasetId: string): Promise<DatasetRecord | null> {
  const cached = datasetCache.get(datasetId);
  if (cached !== undefined) return cached;
  const record = (await idbGet<DatasetRecord>(DATASET_STORE, datasetId)) ?? null;
  datasetCache.set(datasetId, record);
  return record;
}

/* ----------------------------------------------------------------- caches */

/** Evict the oldest quarter once a map reaches its bound. Maps iterate in
 * insertion order, so the first keys are the oldest. */
function bound<K, V>(map: Map<K, V>, limit: number): void {
  if (map.size < limit) return;
  let remaining = Math.ceil(limit / 4);
  for (const oldest of map.keys()) {
    map.delete(oldest);
    if (--remaining <= 0) break;
  }
}

/**
 * Directory handles, keyed by dataset and path prefix.
 *
 * Every plane of an acquisition lives under the same `Image/` directory, so
 * this collapses each request's walk to a single `getFileHandle` call.
 * Entries are dropped only on unmount, so a folder restructured on disk
 * mid-session may need a reload — a trade worth making for the throughput.
 */
const directoryCache = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
const DIRECTORY_CACHE_LIMIT = 512;

async function resolveDirectoryCached(
  datasetId: string,
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle | null> {
  let handle: FileSystemDirectoryHandle = root;

  for (let index = 0; index < segments.length; index += 1) {
    const key = `${datasetId}/${segments.slice(0, index + 1).join('/')}`;
    const cached = directoryCache.get(key);
    if (cached !== undefined) {
      const resolved = await cached;
      if (resolved === null) return null;
      handle = resolved;
      continue;
    }

    const parent = handle;
    const segment = segments[index];
    const pending = (async (): Promise<FileSystemDirectoryHandle | null> => {
      try {
        return await parent.getDirectoryHandle(segment);
      } catch (error) {
        if (isNotFound(error) || isTypeMismatch(error)) return null;
        throw error;
      }
    })();
    bound(directoryCache, DIRECTORY_CACHE_LIMIT);
    directoryCache.set(key, pending);

    const resolved = await pending;
    if (resolved === null) return null;
    handle = resolved;
  }

  return handle;
}

/**
 * Parsed TIFF directories, keyed by dataset and plane path.
 *
 * Reading one costs two small range reads. Caching them matters because a
 * plane is read again whenever the user comes back to it, and because the
 * entries are tiny: a few numbers and a strip table.
 */
const layoutCache = new Map<string, Promise<PlaneLayout>>();
const LAYOUT_CACHE_LIMIT = 4096;

function getPlaneLayout(
  dataset: DatasetRecord,
  path: string,
  file: File,
): Promise<PlaneLayout> {
  const key = `${dataset.id}/${path}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;

  const pending = readPlaneLayout(file);
  // A failed parse is usually permanent, but caching a rejection would make a
  // transient read error stick for the session.
  pending.catch(() => layoutCache.delete(key));
  bound(layoutCache, LAYOUT_CACHE_LIMIT);
  layoutCache.set(key, pending);
  return pending;
}

/* ------------------------------------------------------------ concurrency */

const gate = createGate({
  budget: CHUNK_BUDGET_BYTES,
  maxConcurrent: MAX_CONCURRENT_CHUNKS,
});
