/**
 * The virtual OME-Zarr layer.
 *
 * Each well is presented as one OME-Zarr image — `.zgroup`, `.zattrs` with
 * `multiscales` and `omero`, and one chunked array per resolution level —
 * built from the model on every request. None of it exists on disk, and the
 * original dataset is never touched: OME-Zarr here is a transport, chosen
 * because it is what Neuroglancer already speaks.
 *
 * The one piece of metadata that does real work is the per-level
 * `translation`. It carries the well's position on the physical plate, so
 * opening every well at once assembles a plate rather than a stack of
 * unrelated images — no viewer-side layout, and the same numbers hold whether
 * one well is open or ninety-six.
 */
import { levelExtent } from './model';
import type { ChunkGeometry } from './chunk';
import type { PlateModel, Well } from './types';
import { DIMS } from './types';

/** OME-NGFF version the metadata is written in. Neuroglancer reads 0.4 for Zarr v2. */
const NGFF_VERSION = '0.4';

/** What a request under a well's namespace resolves to. */
export type Resolution =
  | { kind: 'json'; body: string }
  | { kind: 'chunk'; file: string; geometry: ChunkGeometry; dtype: string }
  | { kind: 'empty' }
  | { kind: 'missing' };

/** Shape of a well's array at one resolution level. */
export function levelShape(well: Well, model: PlateModel, level: number) {
  const outY = levelExtent(well.cellY, level);
  const outX = levelExtent(well.cellX, level);
  return {
    outY,
    outX,
    shape: [model.sizeT, model.sizeC, well.sizeZ, well.gridRows * outY, well.gridColumns * outX],
    chunks: [1, 1, 1, outY, outX],
    /** Voxel size in micrometres. Reducing by k halves y and x exactly. */
    scale: [1, 1, model.spacing.z, (model.spacing.y * well.cellY) / outY, (model.spacing.x * well.cellX) / outX],
  };
}

/**
 * `multiscales` + `omero` for one well.
 *
 * The translation names the *centre* of voxel zero, which is the convention
 * OME-NGFF readers assume; adding half a voxel per level is what keeps the
 * levels aligned to each other at their shared corner.
 */
export function wellAttributes(model: PlateModel, well: Well): unknown {
  const datasets = Array.from({ length: well.levels }, (_, level) => {
    const { scale } = levelShape(well, model, level);
    return {
      path: String(level),
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
    };
  });

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
    /** Provenance, for anyone who inspects the virtual store directly. */
    cq3000: {
      plate: model.name,
      well: well.id,
      fields: well.tiles.length,
      grid: [well.gridRows, well.gridColumns],
      source: model.metadataFile,
    },
  };
}

function arrayMetadata(model: PlateModel, well: Well, level: number): unknown {
  const { shape, chunks } = levelShape(well, model, level);
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
function tileAt(well: Well, gridRow: number, gridColumn: number) {
  return well.tiles.find((tile) => tile.gridRow === gridRow && tile.gridColumn === gridColumn);
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

/**
 * Resolve a path inside a well's virtual OME-Zarr image.
 *
 * `segments` is the path below `<well-id>/`: `['.zattrs']`, `['0', '.zarray']`
 * or `['0', '0.1.3.2.4']`. Anything else is a miss, including directories —
 * Zarr never needs a listing.
 */
export function resolve(model: PlateModel, well: Well, segments: string[]): Resolution {
  if (segments.length === 1) {
    if (segments[0] === '.zgroup') {
      return { kind: 'json', body: JSON.stringify({ zarr_format: 2 }) };
    }
    if (segments[0] === '.zattrs') {
      return { kind: 'json', body: JSON.stringify(wellAttributes(model, well)) };
    }
    return { kind: 'missing' };
  }

  if (segments.length !== 2) return { kind: 'missing' };

  const level = /^\d+$/.test(segments[0]) ? Number(segments[0]) : -1;
  if (level < 0 || level >= well.levels) return { kind: 'missing' };

  if (segments[1] === '.zarray') {
    return { kind: 'json', body: JSON.stringify(arrayMetadata(model, well, level)) };
  }
  if (segments[1] === '.zattrs') {
    return { kind: 'json', body: JSON.stringify({ _ARRAY_DIMENSIONS: [...DIMS] }) };
  }

  const indices = parseChunkKey(segments[1], DIMS.length);
  if (!indices) return { kind: 'missing' };

  const { outY, outX, shape, chunks } = levelShape(well, model, level);
  for (let axis = 0; axis < indices.length; axis += 1) {
    if (indices[axis] >= Math.ceil(shape[axis] / chunks[axis])) return { kind: 'missing' };
  }

  const [t, c, z, gridRow, gridColumn] = indices;
  const tile = tileAt(well, gridRow, gridColumn);
  // A gap in the acquisition grid, or a z plane outside this field's stack:
  // Zarr reads a missing chunk as the fill value, so a 404 is the right answer.
  if (!tile) return { kind: 'empty' };
  const localZ = z - tile.zOffset;
  if (localZ < 0 || localZ >= tile.sizeZ) return { kind: 'empty' };

  const file = tile.files[(t * model.sizeC + c) * tile.sizeZ + localZ];
  if (!file) return { kind: 'empty' };

  return {
    kind: 'chunk',
    file,
    dtype: model.dtype,
    geometry: {
      cellY: well.cellY,
      cellX: well.cellX,
      fieldY: tile.sizeY,
      fieldX: tile.sizeX,
      outY,
      outX,
    },
  };
}

/** Look a well up by the id used in its virtual path. */
export function findWell(model: PlateModel, id: string): Well | undefined {
  return model.wells.find((well) => well.id === id);
}
