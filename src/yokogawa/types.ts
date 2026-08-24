/**
 * The plate model: everything the viewer needs to answer a chunk request.
 *
 * A model is built once, on the page, from the dataset's OME-XML (see
 * `ome-xml.ts` and `plate.ts`). It is then handed to the service worker
 * through IndexedDB, so every field here must survive a structured clone —
 * plain objects, arrays, numbers and strings only, no class instances.
 *
 * It describes *where the pixels are*, never what they are: no image data is
 * read while building it, and none is held in it.
 */

/** Axis order of every array this viewer exposes, matching OME-Zarr's `tczyx`. */
export const DIMS = ['t', 'c', 'z', 'y', 'x'] as const;

/** One acquisition channel, as declared by the OME-XML. */
export interface ChannelInfo {
  /** Channel name from the OME-XML, e.g. `Channel 1`. */
  name: string;
  /** `RRGGBB`, decoded from the OME `Color` attribute; white when absent. */
  color: string;
  /** Excitation wavelength in nm, when the OME-XML declares one. */
  excitation?: number;
  /** Emission wavelength in nm, when the OME-XML declares one. */
  emission?: number;
  /** Display range, filled in later by the auto-contrast pass. */
  window: { start: number; end: number; min: number; max: number };
}

/**
 * One field of view: a stack of single-plane TIFF files sharing a stage
 * position. "Field of view" is the OME-Zarr term for what an acquisition puts
 * inside a well.
 */
export interface Field {
  /** Place in the well's acquisition grid, inferred from stage positions. */
  gridRow: number;
  gridColumn: number;
  /** Index of this field's first z plane within the well image. */
  zOffset: number;
  /** Number of z planes in this field. */
  sizeZ: number;
  /** Pixel size of the field of view, before the overlap is trimmed. */
  sizeY: number;
  sizeX: number;
  /**
   * Dataset-relative TIFF paths, indexed `(t * sizeC + c) * sizeZ + z`.
   * A missing plane is the empty string and reads as zeros.
   */
  files: string[];
}

/**
 * One well, exposed as a single image assembled from its fields of view.
 *
 * OME-Zarr places a well at `<row>/<column>` and its fields of view beneath it.
 * The fields here are assembled into one image rather than published
 * separately, so that a viewer opens a well as one source instead of thirty-six
 * — see `zarr.ts`.
 */
export interface Well {
  /** Well name in the usual `B2` form, for display. */
  id: string;
  /** Zero-based place on the plate. `row` 1, `column` 1 is well `B2`. */
  row: number;
  column: number;
  /** Shape of the acquisition grid, in fields of view. */
  gridRows: number;
  gridColumns: number;
  /**
   * Level-0 chunk size in pixels — the acquisition stride, i.e. the field of
   * view minus its overlap. Each chunk holds exactly one field of view,
   * centre-cropped to this size so neighbours abut instead of overlapping.
   */
  strideY: number;
  strideX: number;
  /** Number of z planes spanned by the whole well. */
  sizeZ: number;
  /**
   * Plate-space position, in micrometres, of the *corner* of voxel (0, 0, 0)
   * of the level-0 array. This is what places wells relative to each other.
   */
  origin: { z: number; y: number; x: number };
  /** Number of resolution levels; level *k* is downsampled by 2^k in y and x. */
  levels: number;
  fields: Field[];
}

/** Shape of the plate: how many rows and columns of wells it has. */
export interface PlateGeometry {
  rows: number;
  columns: number;
}

/** A parsed Yokogawa CQ3000 dataset. */
export interface PlateModel {
  /** Name of the dropped folder. */
  folder: string;
  /** Plate name from the OME-XML, e.g. the measurement id. */
  name: string;
  /** Name of the OME-XML the model was built from. */
  metadataFile: string;
  /** Zarr v2 dtype string, e.g. `<u2`. */
  dtype: string;
  bytesPerSample: number;
  sizeT: number;
  sizeC: number;
  channels: ChannelInfo[];
  /** Voxel size in micrometres. */
  spacing: { z: number; y: number; x: number };
  plate: PlateGeometry;
  wells: Well[];
  /** Non-fatal observations worth showing the user. */
  notes: string[];
}

/** Total number of fields of view across the plate. */
export function fieldCount(model: PlateModel): number {
  return model.wells.reduce((total, well) => total + well.fields.length, 0);
}

/** Total number of TIFF planes the model refers to. */
export function planeCount(model: PlateModel): number {
  return model.wells.reduce(
    (total, well) => total + well.fields.reduce((n, field) => n + field.files.length, 0),
    0,
  );
}
