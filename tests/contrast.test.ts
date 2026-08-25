/**
 * The display range has to agree with the pyramid.
 *
 * A range taken too far into the tail of a fluorescence histogram leaves the
 * sample itself in the bottom few per cent of it, and the image looks black —
 * the failure this file exists to catch.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { percentiles, estimateContrast } from '../src/yokogawa/contrast';
import { openDatasetFile } from '../src/vfs/files';
import { readPlaneLayout } from '../src/yokogawa/tiff';
import { serveZarr } from '../src/vfs/serve';
import { loadPlateModel } from '../src/yokogawa/model';
import { imagePath, imageShape } from '../src/yokogawa/zarr';
import { MODEL_VERSION, type DatasetRecord } from '../src/vfs/protocol';
import type { PlateModel, Well } from '../src/yokogawa/types';
import { DEFAULT_FIXTURE, writeFixture } from './fixtures';
import { directoryHandle } from './node-handles';

test('percentiles bracket the bulk of the data', () => {
  // A flat distribution over 0..9999, so the answers are known exactly: the
  // first and ninety-ninth percentiles, not the extremes and not the far tail.
  const values = Float64Array.from({ length: 10000 }, (_, i) => i);
  const range = percentiles(values)!;
  assert.ok(Math.abs(range.low - 100) < 60, `low ${range.low}`);
  assert.ok(Math.abs(range.high - 9900) < 60, `high ${range.high}`);
});

test('percentiles cope with flat and empty input', () => {
  assert.equal(percentiles([]), null);
  const flat = percentiles(new Float64Array(1000).fill(42))!;
  assert.ok(flat.high > flat.low);
  assert.ok(flat.max > flat.min);
});

/** Fraction of samples at or above a quarter of the display range. */
function litFraction(values: Uint16Array, window: { start: number; end: number }): number {
  let lit = 0;
  for (const value of values) {
    if ((value - window.start) / (window.end - window.start) > 0.25) lit += 1;
  }
  return lit / values.length;
}

/** Read every chunk of one channel and z. */
async function imageSamples(
  get: (key: string) => Promise<Response>,
  model: PlateModel,
  well: Well,
): Promise<Uint16Array> {
  const { chunks } = imageShape(well, model);
  const out = new Uint16Array(well.gridRows * chunks[3] * well.gridColumns * chunks[4]);
  let at = 0;
  const z = Math.floor(well.sizeZ / 2);
  for (let gy = 0; gy < well.gridRows; gy += 1) {
    for (let gx = 0; gx < well.gridColumns; gx += 1) {
      const response = await get(`${imagePath(well)}/0/0.0.${z}.${gy}.${gx}`);
      if (response.status !== 200) continue;
      const values = new Uint16Array(await response.arrayBuffer());
      out.set(values, at);
      at += values.length;
    }
  }
  return out.subarray(0, at);
}

test('the display range keeps the image visible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cq3000-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFixture(root, {
    ...DEFAULT_FIXTURE,
    content: 'sparse',
    field: 256,
    stride: 192,
    sizeC: 1,
    sizeZ: 1,
    wells: [{ row: 0, column: 0, gridRows: 2, gridColumns: 2 }],
  });

  const handle = directoryHandle(root, 'FIXTURE');
  const model = await loadPlateModel(handle);
  await estimateContrast(handle, model);

  const window = model.channels[0].window;
  assert.ok(window.end > window.start, 'the range is empty');

  // The contrast control spans the data, not the pixel type. Stretched over
  // 16 bits it cannot be dragged anywhere useful, which reads to a user as the
  // contrast doing nothing at all.
  assert.ok(window.min <= window.start && window.max > window.end, 'the control excludes the range');
  assert.ok(window.max < 65535, `the control still spans the whole pixel type (${window.max})`);

  const dataset: DatasetRecord = { id: 'd', name: 'd', handle, model, version: MODEL_VERSION, createdAt: 0 };
  const prefix = '/_zarr/';
  const get = (key: string) => {
    const url = new URL(`https://example.test${prefix}d/${key}`);
    return serveZarr(new Request(url), url, {
      prefix,
      lookupDataset: async () => dataset,
      openFile: (record, path) => openDatasetFile(record.handle, path),
      planeLayout: (_record, _path, blob) => readPlaneLayout(blob),
    });
  };

  const well = model.wells[0];
  const samples = await imageSamples(get, model, well);

  const quantile = (values: Uint16Array, fraction: number) => {
    const sorted = Array.from(values).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * fraction)];
  };

  // The fixture has to have a tail for the next assertion to mean anything.
  const p99 = quantile(samples, 0.99);
  const p999 = quantile(samples, 0.999);
  assert.ok(p999 > p99 * 2, `fixture tail is too short: p99 ${p99}, p99.9 ${p999}`);

  // The range must follow the bulk of the data. Taking it from the far tail is
  // the bug: it leaves the sample in the bottom few per cent of the range, and
  // a plate overview black.
  assert.ok(
    window.end <= p99 * 1.35,
    `range end ${window.end} is stretched past the 99th percentile (${p99})`,
  );
  assert.ok(window.end >= quantile(samples, 0.9), `range end ${window.end} clips the sample`);

  const lit = litFraction(samples, window);
  assert.ok(lit > 0.02, `only ${(lit * 100).toFixed(2)}% of the image is lit`);
});
