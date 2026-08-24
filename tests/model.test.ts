import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPlateModel } from '../src/yokogawa/model';
import { columnName, rowName, wellName } from '../src/yokogawa/plate';
import { levelShape, imageAttributes } from '../src/yokogawa/zarr';
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

test('rows and columns are named the way OME-Zarr names them', () => {
  assert.equal(rowName(0), 'A');
  assert.equal(rowName(7), 'H');
  assert.equal(rowName(26), 'AA');
  assert.equal(columnName(0), '1');
  assert.equal(columnName(11), '12');
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
  assert.deepEqual(model.wells.map((well) => well.id), ['A1', 'A3', 'B3']);
});

test('the acquisition grid is recovered and the overlap trimmed', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const [a1, , b3] = model.wells;
  assert.equal(a1.gridRows, 2);
  assert.equal(a1.gridColumns, 2);
  // Stride, not field of view: 64 px fields stepping 48.
  assert.equal(a1.strideY, DEFAULT_FIXTURE.stride);
  assert.equal(a1.strideX, DEFAULT_FIXTURE.stride);
  assert.equal(a1.sizeZ, DEFAULT_FIXTURE.sizeZ);
  assert.equal(a1.fields.length, 4);

  // A well with one field has no neighbour, so nothing is trimmed.
  assert.equal(b3.strideY, DEFAULT_FIXTURE.field);
  assert.equal(b3.gridRows, 1);
});

test('wells are spaced by their own extent, not the plate pitch', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const extent = (well: (typeof model.wells)[number]) => ({
    y: well.gridRows * well.strideY * model.spacing.y,
    x: well.gridColumns * well.strideX * model.spacing.x,
  });
  const [a1, a3, b3] = model.wells;

  // The widest well plus half again: an imaged patch is followed by a gap of
  // half its own width, rather than by the millimetres of plastic a real plate
  // would put there.
  const widest = Math.max(
    ...model.wells.flatMap((well) => [extent(well).y, extent(well).x]),
  );
  const pitch = widest * 1.5;
  assert.ok(Math.abs(pitch - 72) < 1e-9, `pitch ${pitch}`);

  // The plate starts at the origin.
  assert.ok(Math.abs(a1.origin.x) < 1e-9 && Math.abs(a1.origin.y) < 1e-9);

  // A1 and A3 were imaged identically, so two columns apart is exactly two
  // pitches, and the gap between them is half the widest well.
  assert.ok(Math.abs(a3.origin.x - a1.origin.x - 2 * pitch) < 1e-9);
  assert.ok(Math.abs(a3.origin.y - a1.origin.y) < 1e-9);
  const gap = a3.origin.x - (a1.origin.x + extent(a1).x);
  assert.ok(Math.abs(gap - (2 * pitch - extent(a1).x)) < 1e-9);
  assert.ok(Math.abs(pitch - extent(a1).x - widest * 0.5) < 1e-9, 'the gap is half the widest well');

  // The next row down sits in the next cell, and stays inside it: a well
  // narrower than the widest is not stretched to fill its place, only kept
  // clear of its neighbours.
  assert.ok(b3.origin.y >= a1.origin.y + pitch - 1e-9);
  assert.ok(b3.origin.y + extent(b3).y <= a1.origin.y + pitch + widest + 1e-9);
});

test('every resolution level covers the same physical extent', async (t) => {
  const { model, cleanup } = await fixtureModel();
  t.after(cleanup);

  const well = model.wells[0];
  // 48 px cells reduce to 24 and 12 before hitting the pyramid floor.
  assert.equal(well.levels, 3);

  const attributes = imageAttributes(model, well) as {
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

  const attributes = imageAttributes(model, model.wells[0]) as {
    omero: { channels: { color: string; label: string; active: boolean }[] };
  };
  assert.deepEqual(
    attributes.omero.channels.map((channel) => channel.color),
    ['00FFFF', 'FF0000'],
  );
  assert.ok(attributes.omero.channels.every((channel) => channel.active));
});
