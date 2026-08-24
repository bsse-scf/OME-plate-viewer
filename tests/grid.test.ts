import assert from 'node:assert/strict';
import test from 'node:test';

import { gridIndices, gridStride } from '../src/yokogawa/grid';

test('clusters overlapping offsets onto grid lines', () => {
  // A 3-wide row of 2000 px fields stepping 1400 px, with stage jitter.
  const offsets = [0, 1399, 2801, 2, 1402, 2798];
  const indices = gridIndices(offsets, 2000);
  assert.deepEqual(indices, [0, 1, 2, 0, 1, 2]);
});

test('recovers the stride as the average step between lines', () => {
  const offsets = [0, 1400, 2800, 2, 1402, 2802];
  const indices = gridIndices(offsets, 2000);
  assert.equal(gridStride(offsets, indices, 2000), 1400);
});

test('a single line has no overlap to trim', () => {
  assert.deepEqual(gridIndices([37], 2000), [0]);
  assert.equal(gridStride([37], [0], 2000), 2000);
});

test('offsets in any order still land on the right lines', () => {
  const offsets = [2801, 0, 1402, 1399, 2798, 2];
  assert.deepEqual(gridIndices(offsets, 2000), [2, 0, 1, 1, 2, 0]);
});
