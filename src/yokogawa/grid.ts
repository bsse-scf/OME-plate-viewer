/**
 * Recovering the acquisition grid from stage positions.
 *
 * A tiled well is acquired on a regular grid, but the fields of view overlap,
 * so their pixel offsets do not tile the plane — they cluster around grid
 * lines. Two small functions are enough to turn those offsets into a grid:
 * one assigns each field to a line, the other measures the step between lines.
 *
 * The step, not the field of view, becomes the chunk size: cropping each field
 * to the step makes neighbours abut exactly, which is what lets a whole well be
 * a single chunked image with one field of view per chunk and no stitching.
 */

/**
 * Cluster one-dimensional pixel offsets into 0-based grid-line indices.
 *
 * Sorting the offsets and starting a new line whenever the gap to the previous
 * one exceeds half a field of view yields one index per field. Robust for
 * overlaps below ~50 %, which covers every acquisition this instrument makes.
 */
export function gridIndices(offsets: number[], fieldSize: number): number[] {
  if (offsets.length === 0) return [];
  const order = offsets.map((_, index) => index).sort((a, b) => offsets[a] - offsets[b]);
  const indices = new Array<number>(offsets.length).fill(0);
  let line = 0;
  let previous = offsets[order[0]];
  for (const index of order) {
    if (offsets[index] - previous > fieldSize / 2) line += 1;
    indices[index] = line;
    previous = offsets[index];
  }
  return indices;
}

/**
 * Average pixel step between adjacent grid lines — the non-overlapping stride.
 *
 * Averaging the offsets on each line before measuring the span absorbs the
 * sub-pixel jitter of a real stage. With a single line there is no neighbour
 * and so no overlap to trim, and the field of view itself is the stride.
 */
export function gridStride(offsets: number[], indices: number[], fallback: number): number {
  const lineCount = Math.max(...indices) + 1;
  if (lineCount <= 1) return Math.round(fallback);

  const sums = new Array<number>(lineCount).fill(0);
  const counts = new Array<number>(lineCount).fill(0);
  for (let i = 0; i < offsets.length; i += 1) {
    sums[indices[i]] += offsets[i];
    counts[indices[i]] += 1;
  }
  const lines = sums.map((sum, line) => sum / counts[line]).sort((a, b) => a - b);
  const stride = Math.round((lines[lineCount - 1] - lines[0]) / (lineCount - 1));
  // A degenerate stride would collapse the array; fall back to no trimming.
  return stride > 0 ? stride : Math.round(fallback);
}
