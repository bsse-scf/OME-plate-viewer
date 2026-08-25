/**
 * Turning one TIFF plane into one Zarr chunk.
 *
 * Every chunk comes from exactly one field of view, which is what keeps the
 * mapping cheap: no chunk spans two files, and no file is opened for a chunk it
 * only partly covers.
 *
 * The only thing that happens on the way is **trimming**. A chunk is the
 * acquisition *stride*, not the field of view, so the overlapping margin is
 * cropped away symmetrically and neighbouring fields abut exactly. Nothing is
 * blended, nothing is resampled, and no pixel is read that is not shown.
 *
 * When the field of view has no overlap to trim, the chunk *is* the plane, and
 * `passthroughRange` says so — its bytes are then a range of the file and this
 * module does nothing at all.
 */
import { readRows, rowRanges, type PlaneLayout } from './tiff';

/** How the chunk sits inside its field of view. */
export interface ChunkGeometry {
  /** Chunk extent: the acquisition stride, in pixels. */
  strideY: number;
  strideX: number;
  /** Declared field-of-view extent, which fixes where the crop starts. */
  fieldY: number;
  fieldX: number;
}

type Numeric = 'int' | 'uint' | 'float';

interface SampleFormat {
  bytes: number;
  kind: Numeric;
  littleEndian: boolean;
}

/** Split a Zarr v2 dtype such as `<u2` into the pieces the reader needs. */
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

/** Where the crop starts inside a field of view, centred on it. */
function inset(field: number, stride: number, available: number): number {
  return Math.max(0, Math.min(Math.floor((field - stride) / 2), Math.max(0, available - stride)));
}

/** Read one sample, honouring the plane's byte order and type. */
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

/** Write one sample into the chunk, in the array's own dtype. */
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
 * file is opened: the rows the crop spans, plus the chunk itself.
 */
export function workingSetBytes(geometry: ChunkGeometry, bytesPerSample: number): number {
  return (
    geometry.strideY * geometry.fieldX * bytesPerSample +
    geometry.strideY * geometry.strideX * bytesPerSample
  );
}

/**
 * A chunk that can be answered as a byte range of the file, with no copy.
 *
 * True wherever a field of view has no overlap to trim — one field per well,
 * the common case for whole-well screening — since the chunk is then exactly
 * the plane.
 */
export function passthroughRange(
  layout: PlaneLayout,
  geometry: ChunkGeometry,
  dtype: string,
): { start: number; end: number } | null {
  const format = parseDtype(dtype);
  if (format.bytes !== layout.bytesPerSample) return null;
  if (format.littleEndian !== layout.littleEndian && format.bytes > 1) return null;
  if (geometry.strideY !== layout.height || geometry.strideX !== layout.width) return null;

  const ranges = rowRanges(layout, 0, layout.height);
  if (ranges.length !== 1) return null;
  const [range] = ranges;
  return range.end - range.start === layout.height * layout.rowBytes ? range : null;
}

/**
 * Build the chunk's bytes: crop, and write in the array's dtype.
 *
 * Only the rows the crop covers are read, and the buffer is allocated at its
 * final size, so peak memory for a request is one chunk plus those rows.
 * Anything the field of view does not reach — a chunk overhanging its edge —
 * stays zero, which is the array's fill value.
 */
export async function materialiseChunk(
  file: Blob,
  layout: PlaneLayout,
  geometry: ChunkGeometry,
  dtype: string,
): Promise<Uint8Array> {
  const target = parseDtype(dtype);
  const out = new Uint8Array(geometry.strideY * geometry.strideX * target.bytes);

  const insetY = inset(geometry.fieldY, geometry.strideY, layout.height);
  const insetX = inset(geometry.fieldX, geometry.strideX, layout.width);
  const rows = Math.min(geometry.strideY, Math.max(0, layout.height - insetY));
  const width = Math.min(geometry.strideX, Math.max(0, layout.width - insetX));
  if (rows === 0 || width === 0) return out;

  const source = await readRows(file, layout, insetY, rows);

  // The plane's samples are usually already the array's, in which case each
  // output row is a contiguous run of an input row.
  if (
    target.bytes === layout.bytesPerSample &&
    (target.bytes === 1 || target.littleEndian === layout.littleEndian)
  ) {
    for (let row = 0; row < rows; row += 1) {
      const from = row * layout.rowBytes + insetX * target.bytes;
      out.set(
        source.subarray(from, from + width * target.bytes),
        row * geometry.strideX * target.bytes,
      );
    }
    return out;
  }

  // A pixel type or byte order the plane does not share: convert sample by
  // sample. No acquisition seen so far needs this, but a TIFF may disagree with
  // what the OME-XML declared.
  const read = sampler({
    bytes: layout.bytesPerSample,
    kind: target.kind,
    littleEndian: layout.littleEndian,
  });
  const write = writer(target);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const outView = new DataView(out.buffer);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < width; column += 1) {
      write(
        outView,
        row * geometry.strideX + column,
        read(view, row * layout.width + insetX + column),
      );
    }
  }
  return out;
}
