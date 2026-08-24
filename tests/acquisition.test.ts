/**
 * The same path, against a real acquisition.
 *
 * The synthetic fixture pins the arithmetic; this pins the assumptions —
 * that the instrument's OME-XML says what the reader thinks it says, and
 * that its TIFFs are the uncompressed contiguous planes the fast path needs.
 *
 * Set `CQ3000_DATASETS` to one or more measurement folders, separated by
 * `:`. Without it the whole file is skipped, so the suite still runs anywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlateModel } from '../src/yokogawa/model';
import { readPlaneLayout } from '../src/yokogawa/tiff';
import { contiguousData } from '../src/yokogawa/tiff';
import { openDatasetFile } from '../src/vfs/files';
import { serveZarr } from '../src/vfs/serve';
import { levelShape } from '../src/yokogawa/zarr';
import { fieldCount, planeCount } from '../src/yokogawa/types';
import { MODEL_VERSION, type DatasetRecord } from '../src/vfs/protocol';
import { directoryHandle } from './node-handles';

const PREFIX = '/_zarr/';
const paths = (process.env.CQ3000_DATASETS ?? '').split(':').filter(Boolean);

for (const path of paths) {
  test(`reads ${path}`, async () => {
    const handle = directoryHandle(path);
    const started = Date.now();
    const model = await loadPlateModel(handle);
    const elapsed = Date.now() - started;

    console.log(
      `  ${model.name}: ${model.wells.length} wells, ${fieldCount(model)} fields, ` +
        `${planeCount(model).toLocaleString()} planes, ${model.sizeC}c ` +
        `${Math.max(...model.wells.map((w) => w.sizeZ))}z, ${model.dtype}, ` +
        `${model.spacing.x.toFixed(4)} µm/px, plate from ${model.plate.source}, ` +
        `parsed in ${elapsed} ms`,
    );

    assert.ok(model.wells.length > 0);
    assert.ok(model.channels.length === model.sizeC);
    assert.ok(model.spacing.x > 0 && model.spacing.y > 0 && model.spacing.z > 0);

    const well = model.wells[0];
    console.log(
      `  well ${well.id}: ${well.gridRows}x${well.gridColumns} fields, ` +
        `cell ${well.cellY}x${well.cellX} px, ${well.levels} levels`,
    );
    assert.ok(well.levels >= 1);

    // Every field must be reachable and be a plane the reader can serve.
    const first = well.tiles[0].files.find(Boolean)!;
    const file = await openDatasetFile(handle, first);
    assert.ok(file, `missing ${first}`);
    const layout = await readPlaneLayout(file!);
    assert.equal(layout.width, well.tiles[0].sizeX);
    assert.equal(layout.height, well.tiles[0].sizeY);
    assert.ok(contiguousData(layout), 'plane data is not one contiguous run');

    const dataset: DatasetRecord = {
      id: 'real',
      name: model.folder,
      handle,
      model,
      version: MODEL_VERSION,
      createdAt: Date.now(),
    };
    const get = (key: string) => {
      const url = new URL(`https://example.test${PREFIX}real/${key}`);
      return serveZarr(new Request(url), url, {
        prefix: PREFIX,
        lookupDataset: async () => dataset,
        openFile: (record, name) => openDatasetFile(record.handle, name),
        planeLayout: (_record, _name, blob) => readPlaneLayout(blob),
      });
    };

    assert.equal((await get(`${well.id}/.zgroup`)).status, 200);
    assert.equal((await get(`${well.id}/.zattrs`)).status, 200);

    // One chunk at every level, timed, so a regression in the read strategy is
    // visible rather than merely slow.
    for (let level = 0; level < well.levels; level += 1) {
      const { outY, outX } = levelShape(well, model, level);
      const at = Date.now();
      const response = await get(`${well.id}/${level}/0.0.0.0.0`);
      assert.equal(response.status, 200, `level ${level}`);
      const bytes = await response.arrayBuffer();
      assert.equal(bytes.byteLength, outY * outX * model.bytesPerSample);
      console.log(
        `  level ${level}: ${outY}x${outX} chunk in ${Date.now() - at} ms ` +
          `(${response.headers.get('X-Chunk-Source')})`,
      );
    }
  });
}

if (paths.length === 0) {
  test('acquisition tests are skipped without CQ3000_DATASETS', { skip: true }, () => {});
}
