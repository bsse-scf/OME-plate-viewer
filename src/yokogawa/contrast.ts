/**
 * Choosing a display range without reading the dataset.
 *
 * Neuroglancer will auto-compute contrast from whatever chunks happen to be
 * loaded, which on a plate means the range flickers as wells stream in. Fixing
 * it up front is both steadier and cheaper — and the cost is one plane per
 * channel, sampled every few rows, out of an acquisition that may hold tens of
 * thousands.
 *
 * The planes sampled are the fields closest to the middle of a well, at mid
 * stack: the part of a well most likely to hold the sample rather than its
 * edge or the meniscus. Their samples are pooled before the percentiles are
 * taken, so one empty field cannot decide the range for the plate.
 */
import { parseDtype } from './chunk';
import { readRows, readPlaneLayout } from './tiff';
import type { Field, PlateModel, Well } from './types';
import { openDatasetFile } from '../vfs/files';

/** Rows read per plane. Enough for a stable percentile, small enough to be free. */
const SAMPLE_ROWS = 96;

/** Fields pooled per channel, nearest the middle of the well. */
const SAMPLE_FIELDS = 3;

/** Histogram resolution used to find the percentiles. */
const BINS = 4096;

/**
 * Percentiles clipped away at each end, as fractions.
 *
 * The high one matters much more than it looks. Fluorescence is a long-tailed
 * distribution — on a real DAPI plane the median is 10 counts, the 99th
 * percentile 297 and the maximum 2859 — so a high percentile chosen a little
 * too far out stretches the range over the tail and leaves the *sample* in the
 * bottom few per cent of it. At 99.9 % barely one pixel in a hundred reaches a
 * quarter brightness; at 99 % it is one in twenty, which is what a field of
 * sparse nuclei should look like.
 *
 * The same number has to serve every resolution level, since Neuroglancer
 * applies one range to the whole multiscale. Measuring on the full-resolution
 * plane is the right basis for that: averaging into coarser levels barely
 * moves the bulk of the distribution — the fraction of pixels above a quarter
 * brightness holds at about 5 % from level 0 down to a 128-fold reduction —
 * even though it does pull the extreme maximum down by a factor of ten.
 */
const LOW = 0.01;
const HIGH = 0.99;

/** The fields of view nearest the centre of a well's acquisition grid. */
function centralFields(well: Well, count: number): Field[] {
  const centreRow = (well.gridRows - 1) / 2;
  const centreColumn = (well.gridColumns - 1) / 2;
  const distance = (field: Field) =>
    (field.gridRow - centreRow) ** 2 + (field.gridColumn - centreColumn) ** 2;
  return well.fields
    .slice()
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, count);
}

/**
 * Low and high percentiles of a sample, via a two-pass histogram, with the
 * extremes it saw.
 *
 * The extremes are not the display range — they are the range the *control*
 * spans, so that dragging it explores the data rather than the sixty-five
 * thousand values the pixel type could in principle hold.
 */
export function percentiles(
  values: ArrayLike<number>,
): { low: number; high: number; min: number; max: number } | null {
  if (values.length === 0) return null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max === min) return { low: min, high: min + 1, min, max: min + 1 };

  const counts = new Uint32Array(BINS);
  const scale = (BINS - 1) / (max - min);
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    counts[Math.round((value - min) * scale)] += 1;
    total += 1;
  }

  const at = (fraction: number): number => {
    let target = fraction * total;
    for (let bin = 0; bin < BINS; bin += 1) {
      target -= counts[bin];
      if (target <= 0) return min + bin / scale;
    }
    return max;
  };

  const low = at(LOW);
  const high = at(HIGH);
  return { low, high: high > low ? high : low + 1, min, max };
}

/** Read a thin sample of one plane, as numbers. */
async function samplePlane(file: Blob): Promise<Float64Array | null> {
  const layout = await readPlaneLayout(file);
  const format = parseDtype(
    `${layout.littleEndian ? '<' : '>'}u${layout.bytesPerSample}`,
  );
  const step = Math.max(1, Math.floor(layout.height / SAMPLE_ROWS));
  const rows = Math.min(SAMPLE_ROWS, Math.ceil(layout.height / step));

  const values = new Float64Array(rows * layout.width);
  let written = 0;
  for (let index = 0; index < rows; index += 1) {
    const buffer = await readRows(file, layout, index * step, 1);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let column = 0; column < layout.width; column += 1) {
      values[written++] =
        format.bytes === 1
          ? view.getUint8(column)
          : format.bytes === 2
            ? view.getUint16(column * 2, layout.littleEndian)
            : view.getUint32(column * 4, layout.littleEndian);
    }
  }
  return written > 0 ? values.subarray(0, written) : null;
}

/**
 * Fill in each channel's display range, in place.
 *
 * Best effort throughout: a plane that cannot be read leaves that channel's
 * full-range default, which is a duller image but never a broken one.
 */
export async function estimateContrast(
  directory: FileSystemDirectoryHandle,
  model: PlateModel,
  onProgress?: (channel: number) => void,
): Promise<void> {
  // The most densely tiled well is the one most likely to have been imaged
  // properly rather than as a preview.
  const well = model.wells.reduce((best, candidate) =>
    candidate.fields.length > best.fields.length ? candidate : best,
  );
  const fields = centralFields(well, SAMPLE_FIELDS);
  if (fields.length === 0) return;

  for (let channel = 0; channel < model.sizeC; channel += 1) {
    onProgress?.(channel);

    const samples: Float64Array[] = [];
    for (const field of fields) {
      const path = field.files[channel * field.sizeZ + Math.floor(field.sizeZ / 2)];
      if (!path) continue;
      try {
        const file = await openDatasetFile(directory, path);
        if (!file) continue;
        const sample = await samplePlane(file);
        if (sample) samples.push(sample);
      } catch {
        // Skip this field; another may still speak for the channel.
      }
    }

    const range = samples.length > 0 && percentiles(concat(samples));
    if (!range) continue; // Leave this channel at its full-range default.

    const window = model.channels[channel].window;
    // The pixel type's own limits, before they are narrowed to the data.
    const floor = window.min;
    const ceiling = window.max;

    window.start = Math.max(floor, Math.floor(range.low));
    window.end = Math.min(ceiling, Math.ceil(range.high));
    // What the contrast control spans. A 16-bit type can hold 65535, but this
    // channel reaches three thousand, and a slider stretched over the type
    // instead of the data cannot be dragged anywhere useful — every setting
    // within reach looks the same, which reads as the range doing nothing.
    //
    // Generous headroom around the display range, but never past the data, and
    // never governed by the data's extreme: one saturated pixel is enough to
    // put the far end back at 65535 and make the slider useless again.
    const spread = Math.max(1, range.high - range.low);
    window.min = Math.max(
      floor,
      Math.min(window.start, Math.floor(Math.max(range.min, range.low - spread))),
    );
    window.max = Math.min(
      ceiling,
      Math.max(window.end + 1, Math.ceil(Math.min(range.max, range.high + 4 * spread))),
    );
  }
}

/** Pool several samples into one array, so the percentiles see them together. */
function concat(parts: Float64Array[]): Float64Array {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const pooled = new Float64Array(total);
  let at = 0;
  for (const part of parts) {
    pooled.set(part, at);
    at += part.length;
  }
  return pooled;
}
