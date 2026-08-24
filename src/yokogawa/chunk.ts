/**
 * Turning one TIFF plane into one Zarr chunk.
 *
 * Every chunk this viewer serves comes from exactly one field of view, which
 * is what keeps the mapping cheap: no chunk ever spans two files, and no file
 * is ever opened for a chunk it only partly covers.
 *
 * Two things happen on the way:
 *
 * 1. **Trimming.** The chunk is the acquisition *stride*, not the field of
 *    view, so the overlapping margin is cropped away symmetrically and
 *    neighbouring fields abut exactly.
 * 2. **Reduction.** At resolution level *k* the chunk is the same crop halved
 *    *k* times. Columns are averaged in full, since they are already in
 *    memory, while rows are *sampled* — at most two source rows per output row
 *    — because a row is the smallest thing worth reading from a file. That is
 *    what makes a plate overview read a sixteenth of the data instead of all
 *    of it.
 */
import { readRows, rowRanges, type PlaneLayout } from './tiff';

/** How the chunk sits inside its field of view, and how far it is reduced. */
export interface ChunkGeometry {
  /** Level-0 chunk extent: the acquisition stride, in pixels. */
  cellY: number;
  cellX: number;
  /** Declared field-of-view extent, which fixes where the crop starts. */
  fieldY: number;
  fieldX: number;
  /** Chunk extent at this resolution level. */
  outY: number;
  outX: number;
}

/** Rows this far apart are read as one range rather than two. */
const MERGE_GAP_BYTES = 16 * 1024;

/** Beyond this sampled fraction of the crop, one sequential read is cheaper. */
const READ_WHOLE_FRACTION = 0.35;

/** At most this many source rows are averaged into one output row. */
const MAX_ROWS_PER_SAMPLE = 2;

type Numeric = 'int' | 'uint' | 'float';

interface SampleFormat {
  bytes: number;
  kind: Numeric;
  littleEndian: boolean;
}

/** Split a Zarr v2 dtype such as `<u2` into the pieces the resampler needs. */
export function parseDtype(dtype: string): SampleFormat {
  const match = /^([<>|])([iuf])(\d+)$/.exec(dtype);
  if (!match) throw new Error(`Unsupported dtype "${dtype}".`);
  const [, order, code, size] = match;
  return {
    bytes: Number(size),
    kind: code === 'i' ? 'int' : code === 'u' ? 'uint' : 'float',
    littleEndian: order !== '>',
  };
}

/** Boundaries of each output pixel in source coordinates, plus the offset. */
function edges(inset: number, span: number, out: number, limit: number): number[] {
  const boundaries = new Array<number>(out + 1);
  for (let i = 0; i <= out; i += 1) {
    boundaries[i] = Math.min(limit, Math.max(0, inset + Math.floor((i * span) / out)));
  }
  return boundaries;
}

/** The single block covering every block in `blocks`, gaps included. */
function spanning(blocks: { firstRow: number; rows: number }[]) {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  return [{ firstRow: first.firstRow, rows: last.firstRow + last.rows - first.firstRow }];
}

/** Where the crop starts inside a field of view, centred on it. */
function inset(field: number, cell: number, available: number): number {
  return Math.max(0, Math.min(Math.floor((field - cell) / 2), Math.max(0, available - cell)));
}

/**
 * Read the source rows an output chunk needs.
 *
 * Returns a lookup from source row to a view of that row. Blocks close
 * together are merged into one read; far apart they stay separate, which is
 * the whole point at coarse levels.
 */
async function readSampledRows(
  file: Blob,
  layout: PlaneLayout,
  blocks: { firstRow: number; rows: number }[],
): Promise<Map<number, Uint8Array>> {
  const merged: { firstRow: number; rows: number }[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const gap = (block.firstRow - (previous.firstRow + previous.rows)) * layout.rowBytes;
      if (gap >= 0 && gap <= MERGE_GAP_BYTES) {
        previous.rows = block.firstRow + block.rows - previous.firstRow;
        continue;
      }
    }
    merged.push({ ...block });
  }

  const buffers = await Promise.all(
    merged.map((block) => readRows(file, layout, block.firstRow, block.rows)),
  );

  const rows = new Map<number, Uint8Array>();
  merged.forEach((block, index) => {
    const buffer = buffers[index];
    for (let row = 0; row < block.rows; row += 1) {
      rows.set(
        block.firstRow + row,
        buffer.subarray(row * layout.rowBytes, (row + 1) * layout.rowBytes),
      );
    }
  });
  return rows;
}

/** Read one sample from a row, honouring the plane's byte order and type. */
function sampler(format: SampleFormat): (view: DataView, index: number) => number {
  const { bytes, kind, littleEndian } = format;
  if (kind === 'float') {
    return bytes === 4
      ? (view, index) => view.getFloat32(index * 4, littleEndian)
      : (view, index) => view.getFloat64(index * 8, littleEndian);
  }
  if (kind === 'int') {
    if (bytes === 1) return (view, index) => view.getInt8(index);
    if (bytes === 2) return (view, index) => view.getInt16(index * 2, littleEndian);
    return (view, index) => view.getInt32(index * 4, littleEndian);
  }
  if (bytes === 1) return (view, index) => view.getUint8(index);
  if (bytes === 2) return (view, index) => view.getUint16(index * 2, littleEndian);
  return (view, index) => view.getUint32(index * 4, littleEndian);
}

/** Write one sample into the output chunk, in the array's own dtype. */
function writer(format: SampleFormat): (view: DataView, index: number, value: number) => void {
  const { bytes, kind, littleEndian } = format;
  if (kind === 'float') {
    return bytes === 4
      ? (view, index, value) => view.setFloat32(index * 4, value, littleEndian)
      : (view, index, value) => view.setFloat64(index * 8, value, littleEndian);
  }
  if (kind === 'int') {
    if (bytes === 1) return (view, index, value) => view.setInt8(index, value);
    if (bytes === 2) return (view, index, value) => view.setInt16(index * 2, value, littleEndian);
    return (view, index, value) => view.setInt32(index * 4, value, littleEndian);
  }
  if (bytes === 1) return (view, index, value) => view.setUint8(index, value);
  if (bytes === 2) return (view, index, value) => view.setUint16(index * 2, value, littleEndian);
  return (view, index, value) => view.setUint32(index * 4, value, littleEndian);
}

/**
 * How much memory building this chunk will hold at once.
 *
 * Estimated from the geometry alone, so admission can be decided before any
 * file is opened. It mirrors the decisions {@link materialiseChunk} makes —
 * how many rows it will sample, and whether it will read them as one span —
 * closely enough to serve as a budget, which is all it is.
 */
export function workingSetBytes(geometry: ChunkGeometry, bytesPerSample: number): number {
  const scaleY = geometry.cellY / geometry.outY;
  const rowsPerSample = Math.max(1, Math.min(MAX_ROWS_PER_SAMPLE, Math.floor(scaleY)));
  const sampled = geometry.outY * rowsPerSample;
  const rows = sampled >= geometry.cellY * READ_WHOLE_FRACTION ? geometry.cellY : sampled;
  return rows * geometry.fieldX * bytesPerSample + geometry.outY * geometry.outX * bytesPerSample;
}

/**
 * A chunk that can be answered as a byte range of the file, with no copy.
 *
 * True for the level-0 chunk of a well whose fields do not overlap — one field
 * per well, the common case for whole-well screening — where the chunk is
 * exactly the plane. Returning the range lets the response stream straight
 * from disk.
 */
export function passthroughRange(
  layout: PlaneLayout,
  geometry: ChunkGeometry,
  dtype: string,
): { start: number; end: number } | null {
  const format = parseDtype(dtype);
  if (format.bytes !== layout.bytesPerSample) return null;
  if (format.littleEndian !== layout.littleEndian && format.bytes > 1) return null;
  if (geometry.outY !== geometry.cellY || geometry.outX !== geometry.cellX) return null;
  if (geometry.cellY !== layout.height || geometry.cellX !== layout.width) return null;

  const ranges = rowRanges(layout, 0, layout.height);
  if (ranges.length !== 1) return null;
  const [range] = ranges;
  return range.end - range.start === layout.height * layout.rowBytes ? range : null;
}

/**
 * Build the chunk's bytes: crop, reduce, and write in the array's dtype.
 *
 * The buffer is allocated at its final size and never grows, so peak memory
 * for a request is one chunk plus the rows it sampled.
 */
export async function materialiseChunk(
  file: Blob,
  layout: PlaneLayout,
  geometry: ChunkGeometry,
  dtype: string,
): Promise<Uint8Array> {
  const target = parseDtype(dtype);
  const source: SampleFormat = {
    bytes: layout.bytesPerSample,
    kind: target.kind,
    littleEndian: layout.littleEndian,
  };

  const insetY = inset(geometry.fieldY, geometry.cellY, layout.height);
  const insetX = inset(geometry.fieldX, geometry.cellX, layout.width);
  const rowEdges = edges(insetY, geometry.cellY, geometry.outY, layout.height);
  const columnEdges = edges(insetX, geometry.cellX, geometry.outX, layout.width);

  const scaleY = geometry.cellY / geometry.outY;
  const rowsPerSample = Math.max(1, Math.min(MAX_ROWS_PER_SAMPLE, Math.floor(scaleY)));

  const blocks: { firstRow: number; rows: number }[] = [];
  for (let j = 0; j < geometry.outY; j += 1) {
    const firstRow = rowEdges[j];
    const rows = Math.min(rowsPerSample, Math.max(0, layout.height - firstRow));
    if (rows > 0) blocks.push({ firstRow, rows });
  }

  // Past a certain sampled fraction the gaps are not worth skipping, and one
  // sequential read beats a scatter of small ones. The span read is the crop,
  // never the whole plane: the trimmed overlap is a third of a field.
  const sampled = blocks.reduce((total, block) => total + block.rows, 0);
  const span = blocks.length > 0 ? spanning(blocks) : blocks;
  const spanRows = span.length > 0 ? span[0].rows : 0;
  const rows = await readSampledRows(
    file,
    layout,
    sampled >= spanRows * READ_WHOLE_FRACTION ? span : blocks,
  );

  const out = new Uint8Array(geometry.outY * geometry.outX * target.bytes);
  const outView = new DataView(out.buffer);
  const write = writer(target);
  const read = sampler(source);

  // Level 0 with no reduction: each output row is a contiguous run of the
  // source row, so copy it rather than walking pixel by pixel.
  const straightCopy =
    geometry.outY === geometry.cellY &&
    geometry.outX === geometry.cellX &&
    target.bytes === source.bytes &&
    target.littleEndian === source.littleEndian;

  for (let j = 0; j < geometry.outY; j += 1) {
    const firstRow = rowEdges[j];
    const rowCount = Math.min(rowsPerSample, Math.max(0, layout.height - firstRow));
    if (rowCount === 0) continue;

    if (straightCopy) {
      const row = rows.get(firstRow);
      if (!row) continue;
      const width = Math.min(geometry.outX, layout.width - insetX);
      out.set(
        row.subarray(insetX * source.bytes, (insetX + width) * source.bytes),
        j * geometry.outX * target.bytes,
      );
      continue;
    }

    const views: DataView[] = [];
    for (let r = 0; r < rowCount; r += 1) {
      const row = rows.get(firstRow + r);
      if (row) views.push(new DataView(row.buffer, row.byteOffset, row.byteLength));
    }
    if (views.length === 0) continue;

    const outRow = j * geometry.outX;
    for (let i = 0; i < geometry.outX; i += 1) {
      const from = columnEdges[i];
      const to = Math.max(from + 1, columnEdges[i + 1]);
      let total = 0;
      let samples = 0;
      for (const view of views) {
        for (let column = from; column < to && column < layout.width; column += 1) {
          total += read(view, column);
          samples += 1;
        }
      }
      if (samples === 0) continue;
      const mean = total / samples;
      write(outView, outRow + i, target.kind === 'float' ? mean : Math.round(mean));
    }
  }

  return out;
}
