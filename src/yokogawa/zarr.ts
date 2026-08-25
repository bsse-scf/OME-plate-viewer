/**
 * The virtual OME-Zarr plate.
 *
 * The whole measurement is presented as an OME-Zarr **plate**, laid out the way
 * the specification says a high-content screening dataset is laid out:
 *
 * ```
 * .zattrs                 "plate" metadata: its rows, columns and wells
 * A/                      a row of the plate
 * A/1/.zattrs             "well" metadata: the fields of view it holds
 * A/1/0/.zattrs           "multiscales" and "omero" — an image
 * A/1/0/0/                the image's one resolution level
 * A/1/0/0/t.c.z.y.x       one chunk, which is one field of view
 * ```
 *
 * None of it exists on disk and the original data is never touched: OME-Zarr
 * here is a transport, chosen because it is what viewers already speak. Writing
 * it as a plate rather than as a heap of images means the well names in the
 * paths are the well names on the bench, and anything that reads OME-Zarr
 * plates can read this one.
 *
 * A well's fields of view are assembled into a single image at `0` instead of
 * being published one by one. The specification allows either — a well holds
 * however many images it holds — and one image per well is the difference
 * between a viewer opening thirty-six sources per well and opening one.
 *
 * The metadata that does the real work is the per-level `translation`. It
 * carries the well's place on the plate, so opening every well at once
 * assembles a plate rather than a stack of unrelated images — no viewer-side
 * layout, and the same numbers hold whether one well is open or ninety-six.
 */
import { columnName, rowName } from './plate';
import type { ChunkGeometry } from './chunk';
import type { PlateModel, Well } from './types';
import { DIMS } from './types';

/** OME-Zarr version the metadata is written in. Neuroglancer reads 0.4 for Zarr v2. */
const NGFF_VERSION = '0.4';

/** The single assembled image inside each well. */
const FIELD_PATH = '0';

/**
 * The image's one resolution level.
 *
 * There is no pyramid: the chunks are the fields of view as acquired, and
 * anything coarser would be a second copy of the data to keep consistent with
 * the first. A viewer zoomed out reduces on the GPU from what it has loaded.
 */
const LEVEL_PATH = '0';

/** What a request under the plate's namespace resolves to. */
export type Resolution =
  | { kind: 'json'; body: string }
  | { kind: 'chunk'; file: string; geometry: ChunkGeometry; dtype: string }
  | { kind: 'empty' }
  | { kind: 'missing' };

/** Shape of a well's assembled image: its grid of fields, chunk by chunk. */
export function imageShape(well: Well, model: PlateModel) {
  return {
    shape: [
      model.sizeT,
      model.sizeC,
      well.sizeZ,
      well.gridRows * well.strideY,
      well.gridColumns * well.strideX,
    ],
    chunks: [1, 1, 1, well.strideY, well.strideX],
    /** Voxel size in micrometres. */
    scale: [1, 1, model.spacing.z, model.spacing.y, model.spacing.x],
  };
}

/** Path of a well's image within the plate, e.g. `B/2/0`. */
export function imagePath(well: Well): string {
  return `${rowName(well.row)}/${columnName(well.column)}/${FIELD_PATH}`;
}

/** `plate` metadata: what the plate holds and where. */
export function plateAttributes(model: PlateModel): unknown {
  const rows = Array.from({ length: model.plate.rows }, (_, row) => ({ name: rowName(row) }));
  const columns = Array.from({ length: model.plate.columns }, (_, column) => ({
    name: columnName(column),
  }));
  return {
    plate: {
      version: NGFF_VERSION,
      name: model.name,
      rows,
      columns,
      wells: model.wells.map((well) => ({
        path: `${rowName(well.row)}/${columnName(well.column)}`,
        rowIndex: well.row,
        columnIndex: well.column,
      })),
      // One assembled image per well, whatever the acquisition grid.
      field_count: 1,
    },
  };
}

/** `well` metadata: the images a well holds. */
export function wellAttributes(): unknown {
  return { well: { version: NGFF_VERSION, images: [{ path: FIELD_PATH }] } };
}

/**
 * `multiscales` and `omero` for a well's assembled image.
 *
 * The translation names the *centre* of voxel zero, which is the convention
 * OME-Zarr readers assume; adding half a voxel per level is what keeps the
 * levels aligned to each other at their shared corner.
 */
export function imageAttributes(model: PlateModel, well: Well): unknown {
  const { scale } = imageShape(well, model);
  const datasets = [
    {
      path: LEVEL_PATH,
      coordinateTransformations: [
        { type: 'scale', scale },
        {
          type: 'translation',
          translation: [
            0,
            0,
            well.origin.z + scale[2] / 2,
            well.origin.y + scale[3] / 2,
            well.origin.x + scale[4] / 2,
          ],
        },
      ],
    },
  ];

  return {
    multiscales: [
      {
        version: NGFF_VERSION,
        name: well.id,
        axes: [
          { name: 't', type: 'time', unit: 'second' },
          { name: 'c', type: 'channel' },
          { name: 'z', type: 'space', unit: 'micrometer' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets,
      },
    ],
    omero: {
      name: well.id,
      version: NGFF_VERSION,
      channels: model.channels.map((channel) => ({
        active: true,
        coefficient: 1,
        color: channel.color,
        family: 'linear',
        inverted: false,
        label: channel.name,
        window: channel.window,
      })),
      rdefs: { defaultT: 0, defaultZ: Math.floor(well.sizeZ / 2), model: 'color' },
    },
  };
}

function arrayMetadata(model: PlateModel, well: Well): unknown {
  const { shape, chunks } = imageShape(well, model);
  return {
    zarr_format: 2,
    shape,
    chunks,
    dtype: model.dtype,
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
    dimension_separator: '.',
  };
}

/** The field of view occupying one grid cell, if any. */
function fieldAt(well: Well, gridRow: number, gridColumn: number) {
  return well.fields.find(
    (field) => field.gridRow === gridRow && field.gridColumn === gridColumn,
  );
}

function parseChunkKey(key: string, rank: number): number[] | null {
  const parts = key.split('.');
  if (parts.length !== rank) return null;
  const indices: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    indices.push(Number(part));
  }
  return indices;
}

const GROUP = JSON.stringify({ zarr_format: 2 });

/** Look a well up by its row and column names, as they appear in the path. */
export function findWell(model: PlateModel, row: string, column: string): Well | undefined {
  return model.wells.find(
    (well) => rowName(well.row) === row && columnName(well.column) === column,
  );
}

/**
 * Resolve a path inside the virtual plate.
 *
 * `segments` is everything below the plate root: `['.zattrs']`,
 * `['B', '2', '.zattrs']`, `['B', '2', '0', '0', '.zarray']` or
 * `['B', '2', '0', '0', '0.1.3.2.4']`. Anything else is a miss, including
 * directories — Zarr never needs a listing.
 */
export function resolve(model: PlateModel, segments: string[]): Resolution {
  const json = (body: unknown): Resolution => ({ kind: 'json', body: JSON.stringify(body) });

  // The plate itself.
  if (segments.length === 1) {
    if (segments[0] === '.zgroup') return { kind: 'json', body: GROUP };
    if (segments[0] === '.zattrs') return json(plateAttributes(model));
    return { kind: 'missing' };
  }
  if (segments.length === 0) return { kind: 'missing' };

  // A row of the plate, which holds nothing but its wells.
  const [row, column, field, ...rest] = segments;
  if (segments.length === 2) {
    const hasRow = model.wells.some((well) => rowName(well.row) === row);
    return hasRow && column === '.zgroup' ? { kind: 'json', body: GROUP } : { kind: 'missing' };
  }

  const well = findWell(model, row, column);
  if (!well) return { kind: 'missing' };

  if (segments.length === 3) {
    if (field === '.zgroup') return { kind: 'json', body: GROUP };
    if (field === '.zattrs') return json(wellAttributes());
    return { kind: 'missing' };
  }
  if (field !== FIELD_PATH) return { kind: 'missing' };

  // The well's assembled image.
  if (rest.length === 1) {
    if (rest[0] === '.zgroup') return { kind: 'json', body: GROUP };
    if (rest[0] === '.zattrs') return json(imageAttributes(model, well));
    return { kind: 'missing' };
  }
  if (rest.length !== 2) return { kind: 'missing' };

  if (rest[0] !== LEVEL_PATH) return { kind: 'missing' };

  if (rest[1] === '.zarray') return json(arrayMetadata(model, well));
  if (rest[1] === '.zattrs') return json({ _ARRAY_DIMENSIONS: [...DIMS] });

  const indices = parseChunkKey(rest[1], DIMS.length);
  if (!indices) return { kind: 'missing' };

  const { shape, chunks } = imageShape(well, model);
  for (let axis = 0; axis < indices.length; axis += 1) {
    if (indices[axis] >= Math.ceil(shape[axis] / chunks[axis])) return { kind: 'missing' };
  }

  const [t, c, z, gridRow, gridColumn] = indices;
  const source = fieldAt(well, gridRow, gridColumn);
  // A gap in the acquisition grid, or a z plane outside this field's stack:
  // Zarr reads a missing chunk as the fill value, so a 404 is the right answer.
  if (!source) return { kind: 'empty' };
  const localZ = z - source.zOffset;
  if (localZ < 0 || localZ >= source.sizeZ) return { kind: 'empty' };

  const file = source.files[(t * model.sizeC + c) * source.sizeZ + localZ];
  if (!file) return { kind: 'empty' };

  return {
    kind: 'chunk',
    file,
    dtype: model.dtype,
    geometry: {
      strideY: well.strideY,
      strideX: well.strideX,
      fieldY: source.sizeY,
      fieldX: source.sizeX,
    },
  };
}
