/**
 * A TIFF reader that reads as little as possible.
 *
 * The CQ3000 writes one uncompressed, single-sample plane per file, with its
 * strips laid out in order. That is the whole reason this viewer can work on a
 * 226 GB dataset in a browser tab: a plane's pixels are already in the layout
 * a Zarr chunk wants, so serving one is a byte range rather than a decode, and
 * a downsampled one only has to touch the rows it actually samples.
 *
 * So this module never decodes an image. It reads the directory — two small
 * ranges — and turns "rows i…j" into file offsets.
 */

/** Where the pixels of an uncompressed plane live, and how they are shaped. */
export interface PlaneLayout {
  width: number;
  height: number;
  bytesPerSample: number;
  /** Byte order of the samples, which a caller may have to swap. */
  littleEndian: boolean;
  /** Bytes per image row. */
  rowBytes: number;
  /** File offset and first row of each strip, ascending by row. */
  strips: { offset: number; firstRow: number; rows: number }[];
}

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planarConfiguration: 284,
  predictor: 317,
  tileWidth: 322,
} as const;

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8,
};

class TiffError extends Error {}

async function readRange(file: Blob, start: number, length: number): Promise<DataView> {
  if (start < 0 || length <= 0 || start + length > file.size) {
    throw new TiffError('TIFF directory points outside the file.');
  }
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

function readIntegers(view: DataView, offset: number, type: number, count: number, le: boolean): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    switch (type) {
      case 1:
      case 2:
      case 6:
      case 7:
        values.push(view.getUint8(offset + i));
        break;
      case 3:
        values.push(view.getUint16(offset + i * 2, le));
        break;
      case 8:
        values.push(view.getInt16(offset + i * 2, le));
        break;
      case 4:
        values.push(view.getUint32(offset + i * 4, le));
        break;
      case 9:
        values.push(view.getInt32(offset + i * 4, le));
        break;
      default:
        throw new TiffError(`Unsupported TIFF value type ${type}.`);
    }
  }
  return values;
}

interface RawEntry {
  type: number;
  count: number;
  /** Inline bytes for values of four bytes or fewer, else the file offset. */
  inline: DataView | null;
  offset: number;
}

/**
 * Read the plane's layout from its TIFF directory.
 *
 * Costs two small reads for the directory itself plus one per tag whose value
 * does not fit in its entry — in practice the two strip tables.
 */
export async function readPlaneLayout(file: Blob): Promise<PlaneLayout> {
  const header = await readRange(file, 0, 8);
  const marker = header.getUint16(0, true);
  const littleEndian = marker === 0x4949;
  if (!littleEndian && marker !== 0x4d4d) throw new TiffError('Not a TIFF file.');

  const magic = header.getUint16(2, littleEndian);
  if (magic === 43) throw new TiffError('BigTIFF is not supported.');
  if (magic !== 42) throw new TiffError('Not a TIFF file.');

  const directoryOffset = header.getUint32(4, littleEndian);
  const count = (await readRange(file, directoryOffset, 2)).getUint16(0, littleEndian);
  const directory = await readRange(file, directoryOffset + 2, count * 12);

  const entries = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const base = i * 12;
    const tag = directory.getUint16(base, littleEndian);
    const type = directory.getUint16(base + 2, littleEndian);
    const valueCount = directory.getUint32(base + 4, littleEndian);
    const size = (TYPE_SIZE[type] ?? 1) * valueCount;
    entries.set(tag, {
      type,
      count: valueCount,
      inline:
        size <= 4
          ? new DataView(directory.buffer, directory.byteOffset + base + 8, 4)
          : null,
      offset: size <= 4 ? 0 : directory.getUint32(base + 8, littleEndian),
    });
  }

  const values = async (tag: number): Promise<number[] | null> => {
    const entry = entries.get(tag);
    if (!entry) return null;
    const view =
      entry.inline ??
      (await readRange(file, entry.offset, (TYPE_SIZE[entry.type] ?? 1) * entry.count));
    return readIntegers(view, 0, entry.type, entry.count, littleEndian);
  };

  const single = async (tag: number, fallback: number): Promise<number> =>
    (await values(tag))?.[0] ?? fallback;

  if (entries.has(TAG.tileWidth)) throw new TiffError('Tiled TIFFs are not supported.');

  const compression = await single(TAG.compression, 1);
  if (compression !== 1) throw new TiffError(`Compressed TIFFs are not supported (compression ${compression}).`);
  const predictor = await single(TAG.predictor, 1);
  if (predictor !== 1) throw new TiffError('TIFF predictors are not supported.');
  const samplesPerPixel = await single(TAG.samplesPerPixel, 1);
  if (samplesPerPixel !== 1) throw new TiffError('Only single-sample TIFF planes are supported.');
  const planar = await single(TAG.planarConfiguration, 1);
  if (planar !== 1) throw new TiffError('Planar TIFFs are not supported.');

  const width = await single(TAG.imageWidth, 0);
  const height = await single(TAG.imageLength, 0);
  const bits = await single(TAG.bitsPerSample, 16);
  if (width <= 0 || height <= 0) throw new TiffError('TIFF plane has no extent.');
  if (bits % 8 !== 0) throw new TiffError(`Unsupported bit depth ${bits}.`);

  const rowsPerStrip = await single(TAG.rowsPerStrip, height);
  const offsets = (await values(TAG.stripOffsets)) ?? [];
  if (offsets.length === 0) throw new TiffError('TIFF plane has no strip offsets.');

  const strips = offsets.map((offset, index) => {
    const firstRow = index * rowsPerStrip;
    return { offset, firstRow, rows: Math.min(rowsPerStrip, height - firstRow) };
  });

  return {
    width,
    height,
    bytesPerSample: bits / 8,
    littleEndian,
    rowBytes: width * (bits / 8),
    strips,
  };
}

/**
 * Byte ranges covering rows `[firstRow, firstRow + rowCount)`, merged.
 *
 * Strips written back to back — which is what the instrument does — collapse
 * to a single range, so the common case is one read.
 */
export function rowRanges(
  layout: PlaneLayout,
  firstRow: number,
  rowCount: number,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const lastRow = Math.min(firstRow + rowCount, layout.height);

  for (const strip of layout.strips) {
    const from = Math.max(firstRow, strip.firstRow);
    const to = Math.min(lastRow, strip.firstRow + strip.rows);
    if (to <= from) continue;
    const start = strip.offset + (from - strip.firstRow) * layout.rowBytes;
    const end = start + (to - from) * layout.rowBytes;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end === start) previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges;
}

/**
 * Read `rowCount` consecutive rows into one buffer.
 *
 * Rows past the end of the plane are left as zeros, which is what a chunk
 * overhanging the edge of a field of view needs.
 */
export async function readRows(
  file: Blob,
  layout: PlaneLayout,
  firstRow: number,
  rowCount: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(rowCount * layout.rowBytes);
  const ranges = rowRanges(layout, firstRow, rowCount);
  let written = 0;
  const parts = await Promise.all(
    ranges.map((range) => file.slice(range.start, range.end).arrayBuffer()),
  );
  for (const part of parts) {
    out.set(new Uint8Array(part), written);
    written += part.byteLength;
  }
  return out;
}

/** Whether the plane's pixels form one uninterrupted run starting at `offset`. */
export function contiguousData(layout: PlaneLayout): { offset: number; length: number } | null {
  const expected = layout.height * layout.rowBytes;
  const ranges = rowRanges(layout, 0, layout.height);
  if (ranges.length !== 1) return null;
  const { start, end } = ranges[0];
  return end - start === expected ? { offset: start, length: expected } : null;
}
