/**
 * Contract shared by the page and the service worker.
 *
 * Both run in the same origin but in different JS realms, so everything they
 * agree on — the IndexedDB names, the URL namespace, the message shapes —
 * lives here and nowhere else.
 */
import type { PlateModel } from '../yokogawa/types';

/**
 * Virtual namespace segment, appended to the deployment base path.
 *
 * The base is not a constant: the site is built with a relative base so one
 * bundle runs at an origin root and at a GitHub Pages project subpath
 * (`/<repo>/`). A service worker can only claim a scope at or below its own
 * path, so there the namespace is `/<repo>/_zarr/...`. Both sides derive the
 * base at runtime — the worker from its registration scope, the page from the
 * same scope once registered.
 */
export const ZARR_SEGMENT = '_zarr';

/** Join a base path (with trailing slash) and a namespace segment. */
export function namespacePrefix(basePath: string, segment: string): string {
  return `${basePath}${segment}/`;
}

export const DB_NAME = 'yokogawa-cq3000-viewer';
export const DB_VERSION = 1;
export const DATASET_STORE = 'datasets';

/**
 * A mounted dataset: the folder it came from, and what was read out of it.
 *
 * `handle` is a live `FileSystemDirectoryHandle`. IndexedDB carries these by
 * structured clone, which is what lets the service worker read the user's
 * files directly instead of proxying every byte through the page — and what
 * lets it keep working after the browser restarts it.
 *
 * `model` holds only geometry and file names. No pixels are ever stored.
 */
export interface DatasetRecord {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  model: PlateModel;
  /** {@link MODEL_VERSION} at the time the model was built. */
  version: number;
  createdAt: number;
}

/**
 * Bumped whenever a model built by an older version would be wrong to reuse.
 *
 * A stored model is not just a cache of the folder: it carries values derived
 * from reading it, the display ranges above all. Reopening a session would
 * otherwise hand a fixed build a model built by a broken one, and the fix would
 * appear not to work.
 */
export const MODEL_VERSION = 2;

/** Messages the page sends to the service worker. */
export type PortalMessage =
  | { type: 'ping' }
  | { type: 'flush'; datasetId?: string };

/** Bumped when the worker's behaviour changes, for debugging. */
export const SW_VERSION = '1';
