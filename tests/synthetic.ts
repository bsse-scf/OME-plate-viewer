/**
 * A synthetic CQ3000 acquisition.
 *
 * The viewer's contract is with a folder, not with an API, so the tests build
 * a real one: an OME-XML plus uncompressed single-plane TIFFs whose pixel
 * values are a known function of their coordinates. Everything from XML
 * parsing to the bytes of a downsampled chunk can then be checked against
 * that function.
 *
 * The folder is produced as a list of files rather than written here, so the
 * same acquisition can be laid down on disk for the Node tests and in the
 * browser's own storage for the end-to-end run.
 */
export interface FixtureOptions {
  /** Field-of-view size, in pixels. */
  field: number;
  /** Grid step, in pixels. `field - stride` is the overlap. */
  stride: number;
  sizeC: number;
  sizeZ: number;
  /** Pixel size in micrometres. */
  spacing: number;
  /** z step in micrometres. */
  zStep: number;
  /** Stage z of the first plane, in micrometres. Real stacks straddle zero. */
  zOrigin: number;
  /** Wells to write: plate position plus the shape of their field grid. */
  wells: { row: number; column: number; gridRows: number; gridColumns: number }[];
  /** Plate geometry written to the `.wpp` sidecar, in millimetres. */
  plate: { columnPitch: number; rowPitch: number; leftMargin: number; topMargin: number };
  /**
   * What the pixels look like.
   *
   * `gradient` is a value that is a distinct function of every coordinate, so a
   * cropped or reduced chunk can be checked arithmetically. `sparse` imitates
   * what a fluorescence channel actually is — a dim background with bright
   * objects over a few per cent of the area — which is the distribution that
   * decides whether the display range and the pyramid agree.
   */
  content: 'gradient' | 'sparse';
}

export const DEFAULT_FIXTURE: FixtureOptions = {
  field: 64,
  stride: 48,
  sizeC: 2,
  sizeZ: 3,
  spacing: 0.5,
  zStep: 2,
  zOrigin: 0,
  wells: [
    { row: 0, column: 0, gridRows: 2, gridColumns: 2 },
    { row: 1, column: 2, gridRows: 1, gridColumns: 1 },
  ],
  // A miniature of a real plate: the pitch is scaled to the fixture's 32 µm
  // fields so that a whole-plate view is as sparse as a real one.
  plate: { columnPitch: 0.2, rowPitch: 0.2, leftMargin: 0.5, topMargin: 0.4 },
  content: 'gradient',
};

/**
 * The value of one pixel.
 *
 * Distinct in every argument and small enough to survive a mean over a 2 x 2
 * block without saturating, so an averaged chunk has a predictable value.
 */
export function pixelValue(
  wellIndex: number,
  fieldIndex: number,
  c: number,
  z: number,
  y: number,
  x: number,
): number {
  return (wellIndex * 7 + fieldIndex * 11 + c * 13 + z * 17 + y * 3 + x) % 4096;
}

/** A deterministic 32-bit hash, so a fixture is the same on every run. */
function hash(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    h ^= value + 0x9e3779b9;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/**
 * A dim background with sparse bright objects, like a fluorescence channel.
 *
 * Blobs sit on a coarse lattice, jittered, so their positions are reproducible
 * and their coverage is a few per cent. One blob in a hundred is an order of
 * magnitude brighter — the aggregates and debris every real plate has — which
 * is what gives the histogram the long tail that decides whether a display
 * range taken from it leaves the image visible or black.
 */
export function sparseValue(
  wellIndex: number,
  fieldIndex: number,
  c: number,
  z: number,
  y: number,
  x: number,
): number {
  const LATTICE = 16;
  let value = 6 + (hash(x, y, c) % 5);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const siteY = Math.floor(y / LATTICE) + dy;
      const siteX = Math.floor(x / LATTICE) + dx;
      const h = hash(siteX, siteY, wellIndex, fieldIndex, c, z);
      if (h % 5 !== 0) continue;
      const centreY = siteY * LATTICE + ((h >>> 4) % LATTICE);
      const centreX = siteX * LATTICE + ((h >>> 10) % LATTICE);
      const radius = 5 + ((h >>> 16) % 3);
      if ((x - centreX) ** 2 + (y - centreY) ** 2 < radius * radius) {
        const bright = 1800 + ((h >>> 20) % 1400);
        value += h % 100 === 0 ? bright * 12 : bright;
      }
    }
  }
  return value;
}

/** Encode a minimal uncompressed little-endian TIFF holding one 16-bit plane. */
export function encodeTiff(width: number, height: number, samples: Uint16Array, rowsPerStrip = height): Uint8Array {
  const rowBytes = width * 2;
  const stripCount = Math.ceil(height / rowsPerStrip);
  const dataStart = 8;
  const dataBytes = height * rowBytes;

  const tags: { tag: number; type: number; values: number[] }[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: [16] },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [1] },
    {
      tag: 273,
      type: 4,
      values: Array.from({ length: stripCount }, (_, i) => dataStart + i * rowsPerStrip * rowBytes),
    },
    { tag: 277, type: 3, values: [1] },
    { tag: 278, type: 4, values: [rowsPerStrip] },
    {
      tag: 279,
      type: 4,
      values: Array.from(
        { length: stripCount },
        (_, i) => Math.min(rowsPerStrip, height - i * rowsPerStrip) * rowBytes,
      ),
    },
  ];

  const typeSize: Record<number, number> = { 3: 2, 4: 4 };
  const inline = (entry: { type: number; values: number[] }) =>
    typeSize[entry.type] * entry.values.length <= 4;

  const directoryStart = dataStart + dataBytes;
  const directoryBytes = 2 + tags.length * 12 + 4;
  let extraOffset = directoryStart + directoryBytes;
  const extras: { offset: number; entry: (typeof tags)[number] }[] = [];
  for (const entry of tags) {
    if (inline(entry)) continue;
    extras.push({ offset: extraOffset, entry });
    extraOffset += typeSize[entry.type] * entry.values.length;
  }

  const out = new Uint8Array(extraOffset);
  const view = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, directoryStart, true);

  for (let i = 0; i < samples.length; i += 1) view.setUint16(dataStart + i * 2, samples[i], true);

  view.setUint16(directoryStart, tags.length, true);
  tags.forEach((entry, index) => {
    const base = directoryStart + 2 + index * 12;
    view.setUint16(base, entry.tag, true);
    view.setUint16(base + 2, entry.type, true);
    view.setUint32(base + 4, entry.values.length, true);
    const write = (at: number, value: number) =>
      entry.type === 3 ? view.setUint16(at, value, true) : view.setUint32(at, value, true);
    if (inline(entry)) {
      entry.values.forEach((value, i) => write(base + 8 + i * typeSize[entry.type], value));
    } else {
      const extra = extras.find((candidate) => candidate.entry === entry)!;
      view.setUint32(base + 8, extra.offset, true);
      entry.values.forEach((value, i) => write(extra.offset + i * typeSize[entry.type], value));
    }
  });
  view.setUint32(directoryStart + 2 + tags.length * 12, 0, true);

  return out;
}

const escapeXml = (text: string) => text.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** One file of a synthetic acquisition, at its path relative to the folder. */
export interface FixtureFile {
  path: string;
  bytes: Uint8Array;
}

/** The name of the OME-XML a built fixture is read through. */
export const FIXTURE_METADATA = 'FIXTURE.ome.xml';

/** Build a complete synthetic dataset folder as a list of files. */
export function buildFixture(options: FixtureOptions = DEFAULT_FIXTURE): FixtureFile[] {
  const files: FixtureFile[] = [];

  const { field, stride, sizeC, sizeZ, spacing, zStep, zOrigin } = options;
  const imageElements: string[] = [];
  const wellElements: string[] = [];
  let imageId = 1;

  for (const [wellIndex, well] of options.wells.entries()) {
    const samples: string[] = [];
    let fieldIndex = 0;
    for (let gridRow = 0; gridRow < well.gridRows; gridRow += 1) {
      for (let gridColumn = 0; gridColumn < well.gridColumns; gridColumn += 1) {
        // Stage coordinates name the centre of the field, relative to the
        // centre of the well, and stage y grows opposite to image y — both
        // conventions the reader has to undo.
        const centreX = (gridColumn - (well.gridColumns - 1) / 2) * stride * spacing;
        const centreY = (gridRow - (well.gridRows - 1) / 2) * stride * spacing;

        const planes: string[] = [];
        const tiffData: string[] = [];
        for (let c = 0; c < sizeC; c += 1) {
          for (let z = 0; z < sizeZ; z += 1) {
            const name = `W${String(wellIndex + 1).padStart(4, '0')}F${String(
              fieldIndex + 1,
            ).padStart(4, '0')}T0001Z${String(z + 1).padStart(3, '0')}C${c + 1}.tif`;

            const value = options.content === 'sparse' ? sparseValue : pixelValue;
            const pixels = new Uint16Array(field * field);
            for (let y = 0; y < field; y += 1) {
              for (let x = 0; x < field; x += 1) {
                pixels[y * field + x] = value(wellIndex, fieldIndex, c, z, y, x);
              }
            }
            files.push({ path: `Image/${name}`, bytes: encodeTiff(field, field, pixels, 8) });

            planes.push(
              `<Plane TheZ="${z}" TheT="0" TheC="${c}" PositionX="${centreX}" ` +
                `PositionY="${-centreY}" PositionZ="${zOrigin + z * zStep}"/>`,
            );
            tiffData.push(
              `<TiffData IFD="0" FirstZ="${z}" FirstT="0" FirstC="${c}" PlaneCount="1">` +
                `<UUID FileName="Image/${name}"/></TiffData>`,
            );
          }
        }

        const channels = Array.from(
          { length: sizeC },
          (_, c) =>
            `<Channel ID="Channel:${imageId}:${c}" Name="Channel ${c + 1}" ` +
            `Color="${c === 0 ? 16777215 : -16776961}" EmissionWavelength="${447 + c * 100}"/>`,
        ).join('');

        imageElements.push(
          `<Image ID="Image:${imageId}" Name="${escapeXml(
            `W${wellIndex + 1}(R${well.row + 1}C${well.column + 1}),A1,F${fieldIndex + 1}`,
          )}"><Pixels ID="Pixels:${imageId}" DimensionOrder="XYZCT" Type="uint16" ` +
            `SizeX="${field}" SizeY="${field}" SizeZ="${sizeZ}" SizeC="${sizeC}" SizeT="1" ` +
            `PhysicalSizeX="${spacing}" PhysicalSizeY="${spacing}" PhysicalSizeZ="${zStep}">` +
            `${channels}${planes.join('')}${tiffData.join('')}</Pixels></Image>`,
        );

        samples.push(
          `<WellSample ID="WellSample:${imageId}" PositionX="${centreX}" ` +
            `PositionY="${-centreY}" Index="${fieldIndex + 1}">` +
            `<ImageRef ID="Image:${imageId}"/></WellSample>`,
        );

        imageId += 1;
        fieldIndex += 1;
      }
    }

    wellElements.push(
      `<Well ID="Well:${wellIndex}" Row="${well.row}" Column="${well.column}">` +
        `${samples.join('')}</Well>`,
    );
  }

  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2013-06">` +
    `<Image ID="Image:0" Name="TitleImage"><Pixels ID="Pixels:0" Type="uint16" ` +
    `SizeX="16" SizeY="16" SizeZ="1" SizeC="1" SizeT="1"/></Image>` +
    imageElements.join('') +
    `<Plate ID="Plate:0" Name="FIXTURE" Rows="8" Columns="12" ` +
    `xmlns="http://www.openmicroscopy.org/Schemas/SPW/2013-06">${wellElements.join('')}</Plate>` +
    `</OME>`;

  const text = (value: string) => new TextEncoder().encode(value);
  files.push({ path: FIXTURE_METADATA, bytes: text(xml) });
  // A second, longer-named document the reader must ignore.
  files.push({ path: 'FIXTURE_MIP.ome.xml', bytes: text(xml) });
  files.push({
    path: 'plate.wpp',
    bytes: text(
      `<?xml version="1.0" encoding="utf-8"?>\n<bts:WellPlateProduct bts:Columns="12" ` +
        `bts:Rows="8" bts:ColumnPitch="${options.plate.columnPitch}" ` +
        `bts:RowPitch="${options.plate.rowPitch}" bts:LeftMargin="${options.plate.leftMargin}" ` +
        `bts:TopMargin="${options.plate.topMargin}" ` +
        `xmlns:bts="http://www.yokogawa.co.jp/BTS/BTSSchema/1.0"/>`,
    ),
  });

  return files;
}
