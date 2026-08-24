import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPlateModel } from '../src/yokogawa/model';
import { parsePlateFile, wellName } from '../src/yokogawa/plate';
import { levelShape, wellAttributes } from '../src/yokogawa/zarr';
import type { PlateModel } from '../src/yokogawa/types';
import { DEFAULT_FIXTURE, writeFixture } from './fixtures';
import { directoryHandle } from './node-handles';

async function fixtureModel(): Promise<{ model: PlateModel; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cq3000-'));
  await writeFixture(root);
  const model = await loadPlateModel(directoryHandle(root, 'FIXTURE'));
  return { model, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('well names follow the plate convention', () => {
  assert.equal(wellName(0, 0), 'A1');
  assert.equal(wellName(7, 11), 'H12');
  assert.equal(wellName(26, 2), 'AA3');
});

test('plate geometry is read from either vendor dialect', () => {
  assert.deepEqual(
    parsePlateFile('<bts:P xmlns:bts="u" bts:ColumnPitch="9" bts:RowPitch="9" bts:LeftMargin="14.38" bts:TopMargin="11.24"/>'),
    { columnPitch: 9, rowPitch: 9, leftMargin: 14.38, topMargin: 11.24 },
  );
  assert.deepEqual(
    parsePlateFile(
      '<icm:Microplate xmlns:icm="u"><icm:WellLocation icm:ColumnPitch="4.5" icm:RowPitch="4.5" ' +
        'icm:LeftMargin="12.13" icm:TopMargin="8.99"/></icm:Microplate>',
    ),
    { columnPitch: 4.5, rowPitch: 4.5, leftMargin: 12.13, topMargin: 8.99 },
  );
  assert.equal(parsePlateFile('<nothing/>'), null);
});

test('the fixture is read into the expected plate', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  assert.equal(model.dtype, '<u2');
  assert.equal(model.sizeC, 2);
  assert.equal(model.sizeT, 1);
  assert.deepEqual(model.spacing, { z: 2, y: 0.5, x: 0.5 });
  assert.equal(model.metadataFile, 'FIXTURE.ome.xml');
  assert.deepEqual(model.channels.map((channel) => channel.color), ['00FFFF', 'FF0000']);
  assert.deepEqual(model.wells.map((well) => well.id), ['A1', 'B3']);
});

test('the acquisition grid is recovered and the overlap trimmed', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const [a1, b3] = model.wells;
  assert.equal(a1.gridRows, 2);
  assert.equal(a1.gridColumns, 2);
  // Stride, not field of view: 64 px fields stepping 48.
  assert.equal(a1.cellY, DEFAULT_FIXTURE.stride);
  assert.equal(a1.cellX, DEFAULT_FIXTURE.stride);
  assert.equal(a1.sizeZ, DEFAULT_FIXTURE.sizeZ);
  assert.equal(a1.tiles.length, 4);

  // A well with one field has no neighbour, so nothing is trimmed.
  assert.equal(b3.cellY, DEFAULT_FIXTURE.field);
  assert.equal(b3.gridRows, 1);
});

test('wells are placed at their real position on the plate', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const centre = (well: (typeof model.wells)[number]) => ({
    x: well.origin.x + (well.gridColumns * well.cellX * model.spacing.x) / 2,
    y: well.origin.y + (well.gridRows * well.cellY * model.spacing.y) / 2,
  });
  const [a1, b3] = model.wells.map(centre);

  // The fixture centres each montage on its well, so the array centres land on
  // the A1 margin and pitch its own plate file declares.
  assert.ok(Math.abs(a1.x - 500) < 1e-6);
  assert.ok(Math.abs(a1.y - 400) < 1e-6);
  // B3 sits two columns and one row away.
  assert.ok(Math.abs(b3.x - a1.x - 2 * 200) < 1e-6);
  assert.ok(Math.abs(b3.y - a1.y - 1 * 200) < 1e-6);
});

test('every resolution level covers the same physical extent', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const well = model.wells[0];
  // 48 px cells reduce to 24 and 12 before hitting the pyramid floor.
  assert.equal(well.levels, 3);

  const attributes = wellAttributes(model, well) as {
    multiscales: { datasets: { coordinateTransformations: { type: string; scale?: number[]; translation?: number[] }[] }[] }[];
  };
  const datasets = attributes.multiscales[0].datasets;
  assert.equal(datasets.length, well.levels);

  for (let level = 0; level < well.levels; level += 1) {
    const { shape, scale, chunks } = levelShape(well, model, level);
    // Same physical size in x and y at every level.
    assert.ok(Math.abs(shape[3] * scale[3] - 96 * 0.5) < 1e-9);
    assert.ok(Math.abs(shape[4] * scale[4] - 96 * 0.5) < 1e-9);
    // One chunk per field of view, at every level.
    assert.equal(shape[3] / chunks[3], well.gridRows);
    assert.equal(shape[4] / chunks[4], well.gridColumns);

    // The declared corner is the same at every level, which is what keeps the
    // levels registered to one another.
    const [{ scale: declared }, { translation }] = datasets[level]
      .coordinateTransformations as unknown as [{ scale: number[] }, { translation: number[] }];
    assert.deepEqual(declared, scale);
    assert.ok(Math.abs(translation[4] - declared[4] / 2 - well.origin.x) < 1e-9);
    assert.ok(Math.abs(translation[3] - declared[3] / 2 - well.origin.y) < 1e-9);
  }
});

test('omero metadata carries the vendor colours', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const attributes = wellAttributes(model, model.wells[0]) as {
    omero: { channels: { color: string; label: string; active: boolean }[] };
  };
  assert.deepEqual(
    attributes.omero.channels.map((channel) => channel.color),
    ['00FFFF', 'FF0000'],
  );
  assert.ok(attributes.omero.channels.every((channel) => channel.active));
});
