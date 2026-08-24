/**
 * Reading the dataset's OME-XML.
 *
 * A CQ3000 acquisition writes one XML document describing the whole plate and
 * a folder of single-plane TIFF files. The XML is the only thing this viewer
 * parses: it names every plane's file, its stage position and its place in the
 * plate, which is exactly the information needed to present a well as one
 * chunked array.
 *
 * The document is read once (see `xml.ts`) and reduced immediately to the
 * compact structures below — a 96-well, 36-field acquisition has some 30 000
 * planes, and keeping their nodes alive would cost far more than the model.
 */
import { childNamed, childrenNamed, parseXml, type XmlNode } from './xml';

/** One field of view as the OME-XML describes it. */
export interface OmeImage {
  id: string;
  name: string;
  sizeT: number;
  sizeC: number;
  sizeZ: number;
  sizeY: number;
  sizeX: number;
  /** OME pixel type, e.g. `uint16`. */
  type: string;
  /** Voxel size in micrometres, from `PhysicalSize*`. */
  spacing: { z: number; y: number; x: number };
  /** Lowest stage position over all planes, in micrometres. */
  position: { z: number; y: number; x: number };
  /** Distinct z stage positions, ascending. */
  zPositions: number[];
  /** Dataset-relative TIFF paths, indexed `(t * sizeC + c) * sizeZ + z`. */
  files: string[];
}

/** A well as the OME-XML describes it: a plate position and its images. */
export interface OmeWell {
  row: number;
  column: number;
  imageIds: string[];
}

export interface OmeChannel {
  name: string;
  color: string | null;
  excitation?: number;
  emission?: number;
}

/** Everything the model builder needs out of one OME-XML document. */
export interface OmeDataset {
  plateName: string;
  plateRows: number;
  plateColumns: number;
  channels: OmeChannel[];
  wells: OmeWell[];
  images: Map<string, OmeImage>;
  notes: string[];
}

/** Images the instrument writes that are not fields of view. */
const NON_FIELD_IMAGE_NAMES = new Set(['TitleImage']);

function integer(node: XmlNode, name: string, fallback = 0): number {
  const raw = node.attributes[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function real(node: XmlNode, name: string): number | null {
  const raw = node.attributes[name];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Decode an OME `Color` attribute into `RRGGBB`.
 *
 * The attribute is a signed 32-bit RGBA integer, so the alpha byte has to be
 * masked off and negative values reinterpreted as unsigned — the instrument
 * writes red as `-16776961`.
 */
export function decodeColor(raw: string): string | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const rgba = value >>> 0;
  const hex = ((rgba >>> 8) & 0xffffff).toString(16).toUpperCase();
  return hex.padStart(6, '0');
}

/** Pick the dataset's primary OME-XML: `<name>.ome.xml`, not `_MIP` or `_Sum`. */
export async function findMetadataFile(
  directory: FileSystemDirectoryHandle,
): Promise<string | null> {
  let best: string | null = null;
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file' || !name.toLowerCase().endsWith('.ome.xml')) continue;
    // The derived projections are named `<base>_MIP.ome.xml` / `_Sum.ome.xml`,
    // so the shortest name is always the full-resolution acquisition.
    if (best === null || name.length < best.length) best = name;
  }
  return best;
}

/**
 * Read the channel list.
 *
 * Channels are declared per image, identically on every field, so the first
 * image that names them speaks for the whole plate.
 */
function parseChannels(images: XmlNode[]): OmeChannel[] {
  for (const image of images) {
    const pixels = childNamed(image, 'Pixels');
    if (!pixels) continue;
    const declared = childrenNamed(pixels, 'Channel');
    if (declared.length === 0 || !declared[0].attributes.Name) continue;
    return declared.map((channel, index) => {
      const rawColor = channel.attributes.Color;
      const excitation = real(channel, 'ExcitationWavelength');
      const emission = real(channel, 'EmissionWavelength');
      return {
        name: channel.attributes.Name ?? `Channel ${index + 1}`,
        color: rawColor ? decodeColor(rawColor) : null,
        ...(excitation !== null ? { excitation } : {}),
        ...(emission !== null ? { emission } : {}),
      };
    });
  }
  return [];
}

/**
 * Reduce one `<Image>` to an {@link OmeImage}.
 *
 * Planes and TiffData are read independently rather than zipped: both carry
 * explicit `TheZ`/`FirstZ`-style indices, so relying on them keeps the mapping
 * correct even when the document lists them in different orders.
 */
function parseImage(image: XmlNode): OmeImage | null {
  const pixels = childNamed(image, 'Pixels');
  if (!pixels) return null;

  const sizeT = integer(pixels, 'SizeT', 1);
  const sizeC = integer(pixels, 'SizeC', 1);
  const sizeZ = integer(pixels, 'SizeZ', 1);
  const sizeY = integer(pixels, 'SizeY', 0);
  const sizeX = integer(pixels, 'SizeX', 0);
  if (sizeY <= 0 || sizeX <= 0) return null;

  const files = new Array<string>(sizeT * sizeC * sizeZ).fill('');
  for (const tiffData of childrenNamed(pixels, 'TiffData')) {
    const fileName = childNamed(tiffData, 'UUID')?.attributes.FileName;
    if (!fileName) continue;
    const t = integer(tiffData, 'FirstT');
    const c = integer(tiffData, 'FirstC');
    const z = integer(tiffData, 'FirstZ');
    if (t >= sizeT || c >= sizeC || z >= sizeZ) continue;
    files[(t * sizeC + c) * sizeZ + z] = fileName;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  const zPositions = new Set<number>();
  for (const plane of childrenNamed(pixels, 'Plane')) {
    const x = real(plane, 'PositionX');
    const y = real(plane, 'PositionY');
    const z = real(plane, 'PositionZ');
    if (x !== null) minX = Math.min(minX, x);
    // Stage y grows towards the back of the instrument while image rows grow
    // downwards, so the axis is flipped here, once, for the whole viewer.
    if (y !== null) minY = Math.min(minY, -y);
    if (z !== null) {
      minZ = Math.min(minZ, z);
      zPositions.add(z);
    }
  }

  return {
    id: image.attributes.ID ?? '',
    name: image.attributes.Name ?? '',
    sizeT,
    sizeC,
    sizeZ,
    sizeY,
    sizeX,
    type: pixels.attributes.Type ?? 'uint16',
    spacing: {
      z: real(pixels, 'PhysicalSizeZ') ?? 1,
      y: real(pixels, 'PhysicalSizeY') ?? 1,
      x: real(pixels, 'PhysicalSizeX') ?? 1,
    },
    position: {
      z: Number.isFinite(minZ) ? minZ : 0,
      y: Number.isFinite(minY) ? minY : 0,
      x: Number.isFinite(minX) ? minX : 0,
    },
    zPositions: [...zPositions].sort((a, b) => a - b),
    files,
  };
}

/**
 * Parse an OME-XML document into the pieces the model builder needs.
 *
 * Well membership comes from `Plate/Well/WellSample/ImageRef` rather than from
 * the images' names: the reference is what the format guarantees, while the
 * `W14(R2C2),A1,F1` naming is a vendor convention.
 */
export function parseOmeXml(xml: string): OmeDataset {
  const root = parseXml(xml);
  if (root.name !== 'OME') {
    throw new Error('This does not look like an OME-XML document.');
  }

  const notes: string[] = [];
  const imageElements = childrenNamed(root, 'Image');
  const channels = parseChannels(imageElements);

  const images = new Map<string, OmeImage>();
  for (const element of imageElements) {
    if (NON_FIELD_IMAGE_NAMES.has(element.attributes.Name ?? '')) continue;
    const image = parseImage(element);
    if (image && image.id) images.set(image.id, image);
  }

  const plate = childNamed(root, 'Plate');
  if (!plate) {
    throw new Error('The OME-XML has no <Plate>, so it is not a CQ3000 plate acquisition.');
  }

  const wells: OmeWell[] = [];
  for (const wellElement of childrenNamed(plate, 'Well')) {
    const imageIds: string[] = [];
    for (const sample of childrenNamed(wellElement, 'WellSample')) {
      const reference = childNamed(sample, 'ImageRef')?.attributes.ID;
      if (reference && images.has(reference)) imageIds.push(reference);
    }
    if (imageIds.length === 0) continue; // A plate position that was not imaged.
    wells.push({
      row: integer(wellElement, 'Row'),
      column: integer(wellElement, 'Column'),
      imageIds,
    });
  }

  if (wells.length === 0) {
    throw new Error('The OME-XML lists no imaged wells.');
  }

  const referenced = new Set(wells.flatMap((well) => well.imageIds));
  const orphans = [...images.keys()].filter((id) => !referenced.has(id));
  if (orphans.length > 0) {
    notes.push(
      `${orphans.length} image${orphans.length === 1 ? '' : 's'} in the OME-XML ` +
        'are not referenced by any well and were skipped.',
    );
  }

  return {
    plateName: plate.attributes.Name ?? '',
    plateRows: integer(plate, 'Rows', 0),
    plateColumns: integer(plate, 'Columns', 0),
    channels,
    wells,
    images,
    notes,
  };
}
