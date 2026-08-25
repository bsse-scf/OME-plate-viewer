/**
 * End-to-end over the virtual namespace.
 *
 * The service worker only wires events; everything that decides what a URL
 * means lives in `serve.ts`, so pointing it at a dataset on disk exercises the
 * whole path Neuroglancer takes — metadata, chunk keys, cropping, reduction,
 * ranges and misses — without a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPlateModel } from '../src/yokogawa/model';
import { passthroughRange } from '../src/yokogawa/chunk';
import { readPlaneLayout } from '../src/yokogawa/tiff';
import { openDatasetFile } from '../src/vfs/files';
import { parsePath, serveZarr } from '../src/vfs/serve';
import { MODEL_VERSION, type DatasetRecord } from '../src/vfs/protocol';
import { DEFAULT_FIXTURE, pixelValue, writeFixture } from './fixtures';
import { directoryHandle } from './node-handles';

const PREFIX = '/_zarr/';

async function mount(): Promise<{
  get: (path: string, init?: RequestInit) => Promise<Response>;
  dataset: DatasetRecord;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cq3000-'));
  await writeFixture(root);
  const handle = directoryHandle(root, 'FIXTURE');
  const dataset: DatasetRecord = {
    id: 'abc123',
    name: 'FIXTURE',
    handle,
    model: await loadPlateModel(handle),
    version: MODEL_VERSION,
    createdAt: Date.now(),
  };

  const get = (path: string, init?: RequestInit) => {
    const url = new URL(`https://example.test${PREFIX}${path}`);
    return serveZarr(new Request(url, init), url, {
      prefix: PREFIX,
      lookupDataset: async (id) => (id === dataset.id ? dataset : null),
      openFile: (record, file) => openDatasetFile(record.handle, file),
      planeLayout: (_record, _file, blob) => readPlaneLayout(blob),
    });
  };

  return { get, dataset, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function samples(response: Response): Promise<Uint16Array> {
  const buffer = await response.arrayBuffer();
  return new Uint16Array(buffer);
}

test('serves the group and array metadata Neuroglancer asks for', async (t) => {
  const { get, cleanup } = await mount();
  t.after(cleanup);

  // The plate, its rows and its wells, the way OME-Zarr lays a screen out.
  const plate = (await (await get('abc123/.zattrs')).json()) as {
    plate: { rows: { name: string }[]; columns: { name: string }[]; wells: unknown[] };
  };
  assert.equal(plate.plate.rows.length, 8);
  assert.equal(plate.plate.columns.length, 12);
  assert.deepEqual(plate.plate.wells, [
    { path: 'A/1', rowIndex: 0, columnIndex: 0 },
    { path: 'A/3', rowIndex: 0, columnIndex: 2 },
    { path: 'B/3', rowIndex: 1, columnIndex: 2 },
  ]);
  assert.deepEqual(await (await get('abc123/A/.zgroup')).json(), { zarr_format: 2 });
  assert.deepEqual(await (await get('abc123/A/1/.zattrs')).json(), {
    well: { version: '0.4', images: [{ path: '0' }] },
  });

  assert.deepEqual(await (await get('abc123/A/1/0/.zgroup')).json(), { zarr_format: 2 });

  const attributes = (await (await get('abc123/A/1/0/.zattrs')).json()) as {
    multiscales: { version: string; axes: { name: string }[]; datasets: unknown[] }[];
  };
  assert.equal(attributes.multiscales[0].version, '0.4');
  assert.deepEqual(
    attributes.multiscales[0].axes.map((axis) => axis.name),
    ['t', 'c', 'z', 'y', 'x'],
  );

  const array = (await (await get('abc123/A/1/0/0/.zarray')).json()) as Record<string, unknown>;
  assert.deepEqual(array.shape, [1, 2, 3, 96, 96]);
  assert.deepEqual(array.chunks, [1, 1, 1, 48, 48]);
  assert.equal(array.dtype, '<u2');
  assert.equal(array.compressor, null);
  assert.equal(array.dimension_separator, '.');

  assert.deepEqual(await (await get('abc123/A/1/0/0/.zattrs')).json(), {
    _ARRAY_DIMENSIONS: ['t', 'c', 'z', 'y', 'x'],
  });
});

test('a full-resolution chunk is the field of view, overlap trimmed', async (t) => {
  const { get, cleanup } = await mount();
  t.after(cleanup);

  // Well A1, channel 1, z 2, grid cell (1, 0) -> the third field written.
  const response = await get('abc123/A/1/0/0/0.1.2.1.0');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), String(48 * 48 * 2));

  const values = await samples(response);
  const inset = (DEFAULT_FIXTURE.field - DEFAULT_FIXTURE.stride) / 2;
  for (const [j, i] of [[0, 0], [1, 5], [47, 47], [20, 31]]) {
    assert.equal(values[j * 48 + i], pixelValue(0, 2, 1, 2, inset + j, inset + i));
  }
});

test('a well with one field is served straight from the file', async (t) => {
  const { get, dataset, cleanup } = await mount();
  t.after(cleanup);

  const response = await get('abc123/B/3/0/0/0.0.1.0.0');
  assert.equal(response.status, 200);

  // No trimming and no reduction, so the chunk *is* the plane: the reader
  // should take the zero-copy decision rather than resampling it.
  const well = dataset.model.wells.find((candidate: { id: string }) => candidate.id === 'B3')!;
  const field = well.fields[0];
  const plane = (await openDatasetFile(dataset.handle, field.files[1]))!;
  const layout = await readPlaneLayout(plane);
  assert.ok(
    passthroughRange(layout, {
      strideY: well.strideY, strideX: well.strideX,
      fieldY: field.sizeY, fieldX: field.sizeX,
    }, dataset.model.dtype),
    'a full-resolution chunk of an untrimmed field should be a byte range',
  );

  const values = await samples(response);
  assert.equal(values.length, DEFAULT_FIXTURE.field ** 2);
  // B3 is the third well the fixture writes.
  assert.equal(values[0], pixelValue(2, 0, 0, 1, 0, 0));
  assert.equal(values[63 * 64 + 63], pixelValue(2, 0, 0, 1, 63, 63));
});

test('honours HEAD and byte ranges', async (t) => {
  const { get, cleanup } = await mount();
  t.after(cleanup);

  const head = await get('abc123/A/1/0/0/0.0.0.0.0', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(48 * 48 * 2));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const partial = await get('abc123/A/1/0/0/0.0.0.0.0', { headers: { Range: 'bytes=0-15' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('Content-Range'), `bytes 0-15/${48 * 48 * 2}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 16);

  const beyond = await get('abc123/A/1/0/0/0.0.0.0.0', { headers: { Range: 'bytes=99999-' } });
  assert.equal(beyond.status, 416);
});

test('misses are honest and never leak outside the dataset', async (t) => {
  const { get, cleanup } = await mount();
  t.after(cleanup);

  assert.equal((await get('nosuch/A1/.zattrs')).status, 404);
  assert.equal((await get('abc123/Z/9/0/.zattrs')).status, 404);
  // There is one resolution level, so there is no second one.
  assert.equal((await get('abc123/A/1/0/1/.zarray')).status, 404);
  // Outside the array's chunk grid.
  assert.equal((await get('abc123/A/1/0/0/0.0.0.9.0')).status, 404);
  // A gap in the grid reads as the fill value, which Zarr spells "not found".
  assert.equal((await get('abc123/B/3/0/0/0.0.0.0.0')).status, 200);
  // An encoded separator survives URL normalisation, so the path parser is
  // what has to reject it — before any handle is touched.
  assert.equal((await get('abc123/A/1/0/%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await get('abc123/A/1/0/.zattrs', { method: 'POST' })).status, 405);
});

test('the path parser refuses anything that could escape the folder', () => {
  // Browsers normalise `.` and `..` away before a worker sees the URL, so
  // these are checked where the guard actually lives.
  assert.equal(parsePath('/_zarr/abc/A1/../secret', PREFIX), null);
  assert.equal(parsePath('/_zarr/abc/A1/%2F..%2Fsecret', PREFIX), null);
  assert.equal(parsePath('/_zarr/abc/A1/%ZZ', PREFIX), null);
  assert.equal(parsePath('/elsewhere/abc', PREFIX), null);
  assert.deepEqual(parsePath('/_zarr/abc/A1/0/0.0.0.0.0', PREFIX), {
    id: 'abc',
    segments: ['A1', '0', '0.0.0.0.0'],
    trailingSlash: false,
  });
});

test('the plate assembles into one coordinate system', async (t) => {
  const { get, cleanup } = await mount();
  t.after(cleanup);

  // The physical centre of a well's array, straight out of the metadata a
  // viewer reads: corner plus half the extent.
  const centre = async (image: string): Promise<number[]> => {
    const attributes = (await (await get(`abc123/${image}/.zattrs`)).json()) as {
      multiscales: {
        datasets: { coordinateTransformations: [{ scale: number[] }, { translation: number[] }] }[];
      }[];
    };
    const array = (await (await get(`abc123/${image}/0/.zarray`)).json()) as { shape: number[] };
    const [{ scale }, { translation }] =
      attributes.multiscales[0].datasets[0].coordinateTransformations;
    return translation.map(
      (value, axis) => value - scale[axis] / 2 + (array.shape[axis] * scale[axis]) / 2,
    );
  };

  const [a1, a3] = await Promise.all([centre('A/1/0'), centre('A/3/0')]);
  // Two columns apart, at the layout's own pitch of 72 µm.
  assert.ok(Math.abs(a3[4] - a1[4] - 2 * 72) < 1e-6);
  assert.ok(Math.abs(a3[3] - a1[3]) < 1e-6);
});
