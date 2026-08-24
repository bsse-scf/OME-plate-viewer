import assert from 'node:assert/strict';
import test from 'node:test';

import { contiguousData, readPlaneLayout, readRows, rowRanges } from '../src/yokogawa/tiff';
import { encodeTiff } from './fixtures';

function plane(width: number, height: number): Uint16Array {
  const samples = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) samples[y * width + x] = y * 1000 + x;
  }
  return samples;
}

test('reads the directory of a single-strip plane', async () => {
  const blob = new Blob([encodeTiff(8, 6, plane(8, 6), 6)]);
  const layout = await readPlaneLayout(blob);

  assert.equal(layout.width, 8);
  assert.equal(layout.height, 6);
  assert.equal(layout.bytesPerSample, 2);
  assert.equal(layout.rowBytes, 16);
  assert.equal(layout.littleEndian, true);
  assert.deepEqual(contiguousData(layout), { offset: 8, length: 96 });
});

test('merges the ranges of back-to-back strips', async () => {
  const blob = new Blob([encodeTiff(8, 12, plane(8, 12), 3)]);
  const layout = await readPlaneLayout(blob);

  assert.equal(layout.strips.length, 4);
  // Rows 2..7 span three strips, which are written contiguously.
  assert.deepEqual(rowRanges(layout, 2, 6), [{ start: 8 + 2 * 16, end: 8 + 8 * 16 }]);
});

test('reads rows back exactly, and zero-fills past the end', async () => {
  const samples = plane(8, 12);
  const blob = new Blob([encodeTiff(8, 12, samples, 3)]);
  const layout = await readPlaneLayout(blob);

  const bytes = await readRows(blob, layout, 5, 4);
  const values = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  for (let row = 0; row < 4; row += 1) {
    for (let x = 0; x < 8; x += 1) {
      assert.equal(values[row * 8 + x], samples[(5 + row) * 8 + x]);
    }
  }

  const overhang = await readRows(blob, layout, 10, 4);
  assert.equal(overhang.length, 4 * 16);
  assert.ok(overhang.subarray(2 * 16).every((byte) => byte === 0));
});

test('refuses what it cannot read as raw bytes', async () => {
  const bytes = encodeTiff(8, 6, plane(8, 6), 6);
  // Tag 259 (Compression) is the fourth entry; flip it to LZW.
  const view = new DataView(bytes.buffer);
  const directory = view.getUint32(4, true);
  for (let i = 0; i < view.getUint16(directory, true); i += 1) {
    const base = directory + 2 + i * 12;
    if (view.getUint16(base, true) === 259) view.setUint16(base + 8, 5, true);
  }
  await assert.rejects(readPlaneLayout(new Blob([bytes])), /Compressed/);
  await assert.rejects(readPlaneLayout(new Blob([new Uint8Array(64)])), /Not a TIFF/);
});
