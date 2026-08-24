/**
 * Neuroglancer integration.
 *
 * Neuroglancer itself is unmodified. It is bundled at `<base>neuroglancer/`
 * and driven entirely through its own `#!{...}` state fragment, which is the
 * upstream-supported way to open a viewer on a given set of sources.
 *
 * Two shapes of state are built here, and the difference is the interesting
 * part:
 *
 * * **One well** becomes one layer with one source, named after the well. The
 *   source URL is the well's path within the plate — `…/B/2/0/` — so the well
 *   it shows is legible wherever the URL appears.
 * * **A whole plate** becomes one layer with *many* sources — one per well.
 *   Neuroglancer composes a layer's sources in the shared coordinate space, so
 *   the per-well `translation` in each image is what lays the plate out.
 *   Ninety-six wells then cost one render layer per channel instead of one per
 *   well and channel, which is the difference between a plate that opens and
 *   one that crawls.
 *
 * In both cases the layer is `type: "auto"`. On load Neuroglancer splits a
 * layer with a channel axis into one layer per channel, taking each channel's
 * colour and display range from the `omero` metadata the worker serves, and
 * blending them additively. That is where the channel colours come from; the
 * viewer needs no configuration for it.
 */
import { imageUrl, siteUrl } from '../vfs/client';
import { levelShape } from '../yokogawa/zarr';
import type { PlateModel, Well } from '../yokogawa/types';

/**
 * A single xy panel, whatever the data.
 *
 * A plate is looked at from above. Orthogonal panels of a screening stack spend
 * three quarters of the window on views of seven z planes seen edge-on, which
 * is the wrong first impression even when the data does have depth — and z
 * stays a scroll away in the xy panel. The other layouts are one click away in
 * each panel's corner, so this is a default rather than a restriction.
 */
const LAYOUT = 'xy';

/**
 * The window the opening view is framed for, in pixels.
 *
 * Neuroglancer's own default is one voxel per screen pixel, which for a plate
 * means opening on a few hundred micrometres of one well — the right data in
 * about the least useful place. The state has to be written before the real
 * window size is known, so it is framed for a nominal one and both axes are
 * fitted: a plate is much wider than it is tall, and fitting only its longer
 * side would leave most of a landscape window empty.
 */
const NOMINAL_VIEWPORT = { width: 1280, height: 760 };

/** Fraction of the window left as margin around the data. */
const VIEWPORT_MARGIN = 1.08;

/**
 * Black behind the slices instead of Neuroglancer's mid grey.
 *
 * Fluorescence is emission on nothing: grey around a well reads as signal and
 * flattens the low end of every channel next to it.
 */
const BACKGROUND = '#000000';

export interface ViewerState {
  dimensions: Record<string, [number, string]>;
  position: number[];
  crossSectionScale: number;
  projectionScale: number;
  crossSectionBackgroundColor: string;
  projectionBackgroundColor: string;
  layers: Array<{ type: string; name: string; source: string | Array<{ url: string }> }>;
  selectedLayer?: { visible: boolean; layer: string };
  toolPalettes: Record<string, { query: string; visible: boolean }>;
  layout: string;
}

/** Physical extent of a selection of wells, in micrometres. */
function plateBounds(model: PlateModel, wells: Well[]) {
  const axis = (pick: (well: Well) => [number, number]) => {
    const spans = wells.map(pick);
    return {
      low: Math.min(...spans.map(([low]) => low)),
      high: Math.max(...spans.map(([, high]) => high)),
    };
  };

  return {
    x: axis((well) => {
      const { shape, scale } = levelShape(well, model, 0);
      return [well.origin.x, well.origin.x + shape[4] * scale[4]];
    }),
    y: axis((well) => {
      const { shape, scale } = levelShape(well, model, 0);
      return [well.origin.y, well.origin.y + shape[3] * scale[3]];
    }),
    z: axis((well) => [well.origin.z, well.origin.z + well.sizeZ * model.spacing.z]),
  };
}

/** A label for a selection: the well itself, or how many there are. */
export function selectionName(model: PlateModel, wells: Well[]): string {
  if (wells.length === 1) return wells[0].id;
  if (wells.length === model.wells.length) return model.name || 'Plate';
  return `${wells.length} wells`;
}

export function buildViewerState(
  datasetId: string,
  model: PlateModel,
  wells: Well[],
): ViewerState {
  const name = selectionName(model, wells);
  const sources = wells.map((well) => ({ url: `zarr://${imageUrl(datasetId, well)}` }));

  // Neuroglancer measures position in voxels of the finest level and zoom in
  // "canonical voxels per viewport pixel", where the canonical voxel is the
  // smallest of the displayed axes. Declaring the axes here rather than leaving
  // them to be inferred keeps that arithmetic tied to the model.
  const { spacing } = model;
  const bounds = plateBounds(model, wells);
  const canonical = Math.min(spacing.x, spacing.y, spacing.z);
  const across = bounds.x.high - bounds.x.low;
  const down = bounds.y.high - bounds.y.low;
  // Micrometres per pixel that fits both axes of the nominal window.
  const resolution =
    Math.max(across / NOMINAL_VIEWPORT.width, down / NOMINAL_VIEWPORT.height) *
    VIEWPORT_MARGIN;
  const deepest = Math.max(across, down, bounds.z.high - bounds.z.low);

  return {
    // Micrometres, declared in metres, which is the unit Neuroglancer works in.
    dimensions: {
      x: [spacing.x * 1e-6, 'm'],
      y: [spacing.y * 1e-6, 'm'],
      z: [spacing.z * 1e-6, 'm'],
      t: [1, 's'],
    },
    position: [
      (bounds.x.low + bounds.x.high) / 2 / spacing.x,
      (bounds.y.low + bounds.y.high) / 2 / spacing.y,
      (bounds.z.low + bounds.z.high) / 2 / spacing.z,
      (model.sizeT - 1) / 2,
    ],
    crossSectionScale: resolution / canonical,
    // Per viewport *height* rather than per pixel, and only used once the user
    // switches to a layout with a 3-D panel.
    projectionScale: (deepest * 1.4) / canonical,
    crossSectionBackgroundColor: BACKGROUND,
    projectionBackgroundColor: BACKGROUND,
    layers: [
      {
        type: 'auto',
        name,
        // A single source stays a plain string, the form Neuroglancer writes
        // itself, so a state copied out of the viewer round-trips unchanged.
        source: sources.length === 1 ? sources[0].url : sources,
      },
    ],
    // The layer is selected but its side panel stays closed: opening it would
    // cover a third of the window with shader controls before the user has
    // seen the image. Selecting it means the panel shows this layer when the
    // user does open it.
    selectedLayer: { visible: false, layer: name },
    // Splitting the channels also makes Neuroglancer open a "Shader controls"
    // palette over the image, unless a palette with that query already exists.
    // Declaring it hidden is how the state says "leave the image alone"; the
    // panel is still one click away in the top bar.
    toolPalettes: { 'Shader controls': { query: 'type:shaderControl', visible: false } },
    layout: LAYOUT,
  };
}

/**
 * URL of the bundled viewer, opened on a selection of wells.
 *
 * `index.html` is named explicitly rather than relying on the host to serve a
 * directory index — true of GitHub Pages, but not of Vite's dev server.
 */
export function viewerUrl(datasetId: string, model: PlateModel, wells: Well[]): string {
  const state = buildViewerState(datasetId, model, wells);
  return `${siteUrl('neuroglancer/index.html')}#!${encodeURIComponent(JSON.stringify(state))}`;
}
