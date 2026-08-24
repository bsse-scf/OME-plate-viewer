/**
 * Assembling the plate model.
 *
 * This is where the OME-XML's per-field description becomes the geometry the
 * viewer serves: fields are clustered onto their acquisition grid, the grid
 * stride becomes the chunk size, and every well is given a position on the
 * physical plate so that the wells assemble into one coordinate system.
 *
 * Nothing here reads pixels. Building the model for a 226 GB, 30 000-plane
 * acquisition touches one XML file and two small sidecars.
 */
import { gridIndices, gridStride } from './grid';
import { findMetadataFile, parseOmeXml, type OmeDataset, type OmeImage } from './ome-xml';
import { wellName } from './plate';
import type { ChannelInfo, Field, PlateModel, PlateGeometry, Well } from './types';

/**
 * Stop adding resolution levels once a chunk would be smaller than this.
 *
 * Coarse levels are what make a whole-plate view affordable — each one costs
 * half as many rows to read as the last — so the pyramid is taken as far down
 * as it usefully goes. Below a handful of pixels a chunk is all overhead: the
 * number of requests per level is fixed at one per field of view, so the read
 * stops shrinking while the per-request cost does not.
 */
const MIN_CHUNK_EXTENT = 8;

/** Hard ceiling on the pyramid, so a pathological stride cannot run away. */
const MAX_LEVELS = 9;

/** Empty space left between wells, as a fraction of the widest well. */
const WELL_GAP = 0.5;

/** OME pixel type to Zarr v2 dtype. TIFF planes are always little-endian here. */
const DTYPES: Record<string, { dtype: string; bytes: number }> = {
  int8: { dtype: '|i1', bytes: 1 },
  uint8: { dtype: '|u1', bytes: 1 },
  int16: { dtype: '<i2', bytes: 2 },
  uint16: { dtype: '<u2', bytes: 2 },
  int32: { dtype: '<i4', bytes: 4 },
  uint32: { dtype: '<u4', bytes: 4 },
  float: { dtype: '<f4', bytes: 4 },
  double: { dtype: '<f8', bytes: 8 },
};

/** Full-range display window for a pixel type, before auto-contrast runs. */
function defaultWindow(omeType: string): { start: number; end: number; min: number; max: number } {
  const limits: Record<string, [number, number]> = {
    int8: [-128, 127],
    uint8: [0, 255],
    int16: [-32768, 32767],
    uint16: [0, 65535],
    int32: [-2147483648, 2147483647],
    uint32: [0, 4294967295],
    float: [0, 1],
    double: [0, 1],
  };
  const [min, max] = limits[omeType] ?? [0, 65535];
  return { start: min, end: max, min, max };
}

/** How many resolution levels a chunk of this size supports. */
export function levelCount(strideY: number, strideX: number): number {
  let levels = 1;
  while (
    levels < MAX_LEVELS &&
    Math.ceil(strideY / 2 ** levels) >= MIN_CHUNK_EXTENT &&
    Math.ceil(strideX / 2 ** levels) >= MIN_CHUNK_EXTENT
  ) {
    levels += 1;
  }
  return levels;
}

/** Chunk extent at a level: the level-0 stride halved once per level. */
export function levelExtent(stride: number, level: number): number {
  return Math.max(1, Math.ceil(stride / 2 ** level));
}

/**
 * The z step actually used by the acquisition.
 *
 * `PhysicalSizeZ` is written as the stack's range divided by its plane count,
 * which is off by a factor of `n/(n-1)` — 7.65 µm where the recorded plane
 * positions step by 8.5. The positions are unambiguous, so they win whenever
 * there are at least two of them.
 */
export function zStepFrom(image: OmeImage): number {
  const { zPositions } = image;
  if (zPositions.length >= 2) {
    const steps = zPositions.slice(1).map((z, index) => z - zPositions[index]);
    steps.sort((a, b) => a - b);
    const median = steps[steps.length >> 1];
    if (median > 0) return median;
  }
  return image.spacing.z > 0 ? image.spacing.z : 1;
}

function buildWell(
  row: number,
  column: number,
  images: OmeImage[],
  spacing: { z: number; y: number; x: number },
  notes: string[],
): Well {
  const fieldY = Math.max(...images.map((image) => image.sizeY));
  const fieldX = Math.max(...images.map((image) => image.sizeX));

  // Overlap-accurate pixel offsets, used only to recover the grid — the fields
  // are then placed on the grid itself, so a wobbling stage cannot shear the
  // mosaic.
  const originStage = {
    z: Math.min(...images.map((image) => image.position.z)),
    y: Math.min(...images.map((image) => image.position.y)),
    x: Math.min(...images.map((image) => image.position.x)),
  };
  const offsetsY = images.map((image) => (image.position.y - originStage.y) / spacing.y);
  const offsetsX = images.map((image) => (image.position.x - originStage.x) / spacing.x);

  const rowIndices = gridIndices(offsetsY, fieldY);
  const columnIndices = gridIndices(offsetsX, fieldX);
  const strideY = Math.min(gridStride(offsetsY, rowIndices, fieldY), fieldY);
  const strideX = Math.min(gridStride(offsetsX, columnIndices, fieldX), fieldX);

  const fields: Field[] = images.map((image, index) => ({
    gridRow: rowIndices[index],
    gridColumn: columnIndices[index],
    zOffset: Math.max(0, Math.round((image.position.z - originStage.z) / spacing.z)),
    sizeZ: image.sizeZ,
    sizeY: image.sizeY,
    sizeX: image.sizeX,
    files: image.files,
  }));

  const occupied = new Set(fields.map((field) => `${field.gridRow}/${field.gridColumn}`));
  if (occupied.size !== fields.length) {
    notes.push(
      `Well ${wellName(row, column)}: two fields of view landed on the same place ` +
        'in the acquisition grid, so some of them are not shown.',
    );
  }

  // Trimming the overlap removes the same margin from every side, so the image
  // starts half an overlap inside the first field of view. Stage positions name
  // the centre of a field, and the image starts at its top-left corner.
  const insetY = Math.floor((fieldY - strideY) / 2);
  const insetX = Math.floor((fieldX - strideX) / 2);

  return {
    id: wellName(row, column),
    row,
    column,
    gridRows: Math.max(...rowIndices) + 1,
    gridColumns: Math.max(...columnIndices) + 1,
    strideY,
    strideX,
    sizeZ: Math.max(...fields.map((field) => field.zOffset + field.sizeZ)),
    // Relative to the well's own stage origin for now; `layOutPlate` turns
    // these into plate coordinates once every well's extent is known.
    origin: {
      z: originStage.z,
      y: originStage.y - (fieldY / 2 - insetY) * spacing.y,
      x: originStage.x - (fieldX / 2 - insetX) * spacing.x,
    },
    levels: levelCount(strideY, strideX),
    fields,
  };
}

/**
 * Space the wells out on a common coordinate system.
 *
 * Not at their physical pitch. A 9 mm well spaced by its own 2.7 mm of imaged
 * area would put two thirds of a plate view on empty plastic, and the point of
 * looking at a whole plate is to compare the wells, not to measure the gaps
 * between them. So the pitch is the widest well plus half again, which keeps
 * the wells apart, keeps the plate reading as a plate, and keeps the eye on the
 * data. Everything inside a well stays exactly where the stage put it.
 */
function layOutPlate(wells: Well[], spacing: { y: number; x: number }): void {
  const extent = (well: Well) => ({
    y: well.gridRows * well.strideY * spacing.y,
    x: well.gridColumns * well.strideX * spacing.x,
  });

  const widest = Math.max(...wells.flatMap((well) => [extent(well).y, extent(well).x]));
  const pitch = widest * (1 + WELL_GAP);

  // Wells share an acquisition pattern, so aligning their images by their own
  // lowest corner keeps them consistent with one another.
  const lowest = {
    y: Math.min(...wells.map((well) => well.origin.y)),
    x: Math.min(...wells.map((well) => well.origin.x)),
  };
  for (const well of wells) {
    well.origin.y = well.origin.y - lowest.y + well.row * pitch;
    well.origin.x = well.origin.x - lowest.x + well.column * pitch;
  }
}

/**
 * Turn a parsed OME-XML document into a {@link PlateModel}.
 *
 * Split out from {@link loadPlateModel} so it can be exercised without a
 * filesystem.
 */
export function buildPlateModel(
  dataset: OmeDataset,
  options: { folder: string; metadataFile: string },
): PlateModel {
  const notes = [...dataset.notes];
  const first = dataset.images.get(dataset.wells[0].imageIds[0]);
  if (!first) throw new Error('The OME-XML references a well image it does not describe.');

  const pixelType = first.type;
  const dtype = DTYPES[pixelType];
  if (!dtype) throw new Error(`Unsupported pixel type "${pixelType}".`);

  const spacing = {
    z: zStepFrom(first),
    y: first.spacing.y,
    x: first.spacing.x,
  };

  const wells: Well[] = [];
  for (const well of dataset.wells) {
    const images = well.imageIds
      .map((id) => dataset.images.get(id))
      .filter((image): image is OmeImage => image !== undefined);

    const mismatched = images.filter(
      (image) =>
        image.type !== pixelType ||
        image.sizeC !== first.sizeC ||
        image.sizeT !== first.sizeT ||
        Math.abs(image.spacing.x - spacing.x) > 1e-9 ||
        Math.abs(image.spacing.y - spacing.y) > 1e-9,
    );
    if (mismatched.length > 0) {
      notes.push(
        `Well ${wellName(well.row, well.column)}: ${mismatched.length} field(s) differ ` +
          'in pixel type, channel count or pixel size from the rest of the plate and were skipped.',
      );
    }
    const usable = images.filter((image) => !mismatched.includes(image));
    if (usable.length === 0) continue;

    wells.push(buildWell(well.row, well.column, usable, spacing, notes));
  }

  if (wells.length === 0) throw new Error('No well in this dataset could be read.');
  layOutPlate(wells, spacing);

  const plate: PlateGeometry = {
    rows: dataset.plateRows || Math.max(...wells.map((well) => well.row)) + 1,
    columns: dataset.plateColumns || Math.max(...wells.map((well) => well.column)) + 1,
  };

  const channels: ChannelInfo[] = Array.from({ length: first.sizeC }, (_, index) => {
    const declared = dataset.channels[index];
    return {
      name: declared?.name ?? `Channel ${index + 1}`,
      color: declared?.color ?? 'FFFFFF',
      ...(declared?.excitation !== undefined ? { excitation: declared.excitation } : {}),
      ...(declared?.emission !== undefined ? { emission: declared.emission } : {}),
      window: defaultWindow(pixelType),
    };
  });

  return {
    folder: options.folder,
    name: dataset.plateName || options.folder,
    metadataFile: options.metadataFile,
    dtype: dtype.dtype,
    bytesPerSample: dtype.bytes,
    sizeT: first.sizeT,
    sizeC: first.sizeC,
    channels,
    spacing,
    plate,
    wells,
    notes,
  };
}

/** Read a dropped dataset folder and build its model. */
export async function loadPlateModel(
  directory: FileSystemDirectoryHandle,
  onProgress?: (stage: string) => void,
): Promise<PlateModel> {
  onProgress?.('Looking for the OME-XML…');
  const metadataFile = await findMetadataFile(directory);
  if (!metadataFile) {
    throw new Error(
      'No *.ome.xml file in this folder. Drop the measurement folder itself — the one ' +
        'holding the OME-XML and the Image/ directory.',
    );
  }

  onProgress?.(`Reading ${metadataFile}…`);
  const file = await (await directory.getFileHandle(metadataFile)).getFile();
  const xml = await file.text();

  onProgress?.('Parsing the plate description…');
  const dataset = parseOmeXml(xml);

  return buildPlateModel(dataset, { folder: directory.name, metadataFile });
}
