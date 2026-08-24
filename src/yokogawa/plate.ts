/**
 * Physical plate geometry.
 *
 * Stage positions in the OME-XML are relative to the centre of each well, so
 * placing wells next to each other needs one more piece of information: the
 * well pitch. The instrument writes it beside the images, in two files that
 * say the same thing in different dialects, and standard SBS plates are a last
 * resort when neither is present.
 *
 * Getting this right is what makes the assembled view a *plate*: wells sit
 * 9 mm apart with the imaged patch small in the middle of each, exactly as on
 * the bench, rather than packed edge to edge.
 */
import type { PlateGeometry } from './types';
import { descendantsNamed, parseXml, type XmlNode } from './xml';

/**
 * SBS/ANSI footprint geometry, in millimetres, keyed by `rows x columns`.
 *
 * Only the well pitch and the A1 offset matter here; every format shares the
 * same 127.76 x 85.48 mm outline.
 */
const SBS_STANDARD: Record<string, Omit<PlateGeometry, 'rows' | 'columns' | 'source'>> = {
  '2x3': { rowPitch: 39.12, columnPitch: 39.12, leftMargin: 24.76, topMargin: 23.16 },
  '3x4': { rowPitch: 26.01, columnPitch: 26.01, leftMargin: 24.94, topMargin: 16.79 },
  '4x6': { rowPitch: 19.3, columnPitch: 19.3, leftMargin: 17.48, topMargin: 13.49 },
  '6x8': { rowPitch: 18, columnPitch: 18, leftMargin: 18.21, topMargin: 15.34 },
  '8x12': { rowPitch: 9, columnPitch: 9, leftMargin: 14.38, topMargin: 11.24 },
  '16x24': { rowPitch: 4.5, columnPitch: 4.5, leftMargin: 12.13, topMargin: 8.99 },
  '32x48': { rowPitch: 2.25, columnPitch: 2.25, leftMargin: 11.01, topMargin: 7.87 },
};

function numericAttributes(node: XmlNode, names: readonly string[]): number[] | null {
  const values: number[] = [];
  for (const name of names) {
    const raw = node.attributes[name];
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    values.push(value);
  }
  return values;
}

const PITCH_FIELDS = ['ColumnPitch', 'RowPitch', 'LeftMargin', 'TopMargin'] as const;

/**
 * Pull the well pitch out of one vendor document.
 *
 * `.wpp` (the well-plate product file) carries it on the root element;
 * `MP_*.xml` (the microplate definition) carries it on a `WellLocation` child.
 * Both are tried on every candidate rather than keyed by file name, since the
 * two formats are otherwise indistinguishable from outside — and both write
 * the same attribute names under different namespace prefixes, which the XML
 * reader has already dropped.
 */
export function parsePlateFile(
  xml: string,
): Omit<PlateGeometry, 'rows' | 'columns' | 'source'> | null {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }

  for (const candidate of [root, ...descendantsNamed(root, 'WellLocation')]) {
    const values = numericAttributes(candidate, PITCH_FIELDS);
    if (!values) continue;
    const [columnPitch, rowPitch, leftMargin, topMargin] = values;
    return { columnPitch, rowPitch, leftMargin, topMargin };
  }
  return null;
}

/** Geometry implied by the plate's row and column count, when there is one. */
export function standardGeometry(rows: number, columns: number): PlateGeometry | null {
  const standard = SBS_STANDARD[`${rows}x${columns}`];
  if (!standard) return null;
  return { rows, columns, ...standard, source: `standard ${rows * columns}-well plate` };
}

/**
 * Fall back to a pitch derived from the data itself.
 *
 * Used only for plates with no vendor file and no standard footprint: spacing
 * the wells by their own imaged extent keeps them from overlapping, which is
 * the one property the layout cannot do without.
 */
export function derivedGeometry(
  rows: number,
  columns: number,
  wellExtentMm: number,
): PlateGeometry {
  const pitch = Math.max(wellExtentMm * 1.15, 1);
  return {
    rows,
    columns,
    rowPitch: pitch,
    columnPitch: pitch,
    leftMargin: pitch / 2,
    topMargin: pitch / 2,
    source: 'derived from the imaged extent',
  };
}

/**
 * Read the plate geometry from a dataset folder.
 *
 * Returns `null` when neither vendor file is present or parsable, leaving the
 * caller to fall back to {@link standardGeometry} or {@link derivedGeometry}.
 */
export async function readPlateGeometry(
  directory: FileSystemDirectoryHandle,
  rows: number,
  columns: number,
): Promise<PlateGeometry | null> {
  const candidates: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file') continue;
    const lower = name.toLowerCase();
    // `.wpp` first: it is written per acquisition, while `MP_*.xml` is a copy
    // of the instrument's plate library entry.
    if (lower.endsWith('.wpp')) candidates.unshift(name);
    else if (lower.startsWith('mp_') && lower.endsWith('.xml')) candidates.push(name);
  }

  for (const name of candidates) {
    try {
      const file = await (await directory.getFileHandle(name)).getFile();
      const geometry = parsePlateFile(await file.text());
      if (geometry) return { rows, columns, ...geometry, source: name };
    } catch {
      // An unreadable or malformed sidecar is not worth failing the load over.
    }
  }
  return null;
}

/** Centre of a well on the plate, in micrometres from the plate's top-left. */
export function wellCentre(
  geometry: PlateGeometry,
  row: number,
  column: number,
): { x: number; y: number } {
  return {
    x: (geometry.leftMargin + column * geometry.columnPitch) * 1000,
    y: (geometry.topMargin + row * geometry.rowPitch) * 1000,
  };
}

/** Well name in the usual `A1` / `H12` / `AA3` form. */
export function wellName(row: number, column: number): string {
  let letters = '';
  let remaining = row;
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `${letters}${column + 1}`;
}
