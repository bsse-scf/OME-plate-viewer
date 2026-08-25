/**
 * The browser end-to-end run, page side.
 *
 * Everything from the drop onwards is real: a synthetic acquisition is written
 * into the browser's own storage, opened with the same reader the drop path
 * uses, registered as a dataset, and handed to the same Neuroglancer state
 * builder. The one thing this cannot cover is acquiring the folder handle from
 * a drag-and-drop, which needs a human — an origin-private handle is an
 * ordinary `FileSystemDirectoryHandle`, so the worker, the reader and the
 * viewer all take the path they would take for a real folder.
 *
 * Loaded only by `tests/browser/run.mjs`, through the dev server; nothing in
 * `src/` imports it and it is not part of any build.
 */
import { viewerUrl } from '../../src/integrations/neuroglancer';
import { createDataset, removeAllDatasets } from '../../src/mounts/registry';
import { ensureServiceWorker, imageUrl } from '../../src/vfs/client';
import { estimateContrast } from '../../src/yokogawa/contrast';
import { loadPlateModel } from '../../src/yokogawa/model';
import { buildFixture, DEFAULT_FIXTURE, pixelValue } from '../synthetic';

export interface Harness {
  datasetId: string;
  wells: string[];
  channels: string[];
  /** Chunk extent at level 0, for the byte-level check. */
  stride: number;
  imageRoot: string;
  singleWellUrl: string;
  wholePlateUrl: string;
}

/** Write the synthetic acquisition into origin-private storage. */
async function writeFixtureToStorage(): Promise<FileSystemDirectoryHandle> {
  const storage = await navigator.storage.getDirectory();
  await storage.removeEntry('acquisition', { recursive: true }).catch(() => {});
  const root = await storage.getDirectoryHandle('acquisition', { create: true });

  for (const file of buildFixture()) {
    const parts = file.path.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }
    const handle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.bytes);
    await writable.close();
  }
  return root;
}

export async function setUp(): Promise<Harness> {
  await ensureServiceWorker();
  await removeAllDatasets();

  const handle = await writeFixtureToStorage();
  const model = await loadPlateModel(handle);
  await estimateContrast(handle, model);
  const dataset = await createDataset(handle, model);

  return {
    datasetId: dataset.id,
    wells: model.wells.map((well) => well.id),
    channels: model.channels.map((channel) => channel.name),
    stride: model.wells[0].strideY,
    imageRoot: imageUrl(dataset.id, model.wells[0]),
    singleWellUrl: viewerUrl(dataset.id, model, [model.wells[0]]),
    wholePlateUrl: viewerUrl(dataset.id, model, model.wells),
  };
}

/** Read one full-resolution chunk back and check it against the generator. */
export async function verifyChunk(harness: Harness): Promise<string | null> {
  const response = await fetch(`${harness.imageRoot}0/0.1.2.1.0`);
  if (!response.ok) return `chunk request failed: ${response.status}`;

  const values = new Uint16Array(await response.arrayBuffer());
  if (values.length !== harness.stride ** 2) return `chunk has ${values.length} samples`;

  const inset = (DEFAULT_FIXTURE.field - DEFAULT_FIXTURE.stride) / 2;
  for (const [j, i] of [[0, 0], [17, 5], [harness.stride - 1, harness.stride - 1]]) {
    // Well 0, third field, channel 1, z 2 — the same chunk the Node tests read.
    const expected = pixelValue(0, 2, 1, 2, inset + j, inset + i);
    const actual = values[j * harness.stride + i];
    if (actual !== expected) return `pixel (${j}, ${i}) is ${actual}, expected ${expected}`;
  }
  return null;
}

export async function tearDown(): Promise<void> {
  await removeAllDatasets();
  const storage = await navigator.storage.getDirectory();
  await storage.removeEntry('acquisition', { recursive: true }).catch(() => {});
}
