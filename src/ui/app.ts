/**
 * Landing-page controller: the drop target, the dataset summary and plate map,
 * and the Neuroglancer overlay.
 */
import { viewerUrl } from '../integrations/neuroglancer';
import { extractHandles, isDirectoryPickerSupported, isDropSupported, type DropExtraction } from '../mounts/drop';
import {
  createDataset,
  listDatasets,
  pruneUnreadableDatasets,
  removeAllDatasets,
  type Dataset,
} from '../mounts/registry';
import { ensureServiceWorker, ServiceWorkerUnavailableError } from '../vfs/client';
import { estimateContrast } from '../yokogawa/contrast';
import { loadPlateModel } from '../yokogawa/model';
import { fieldCount, planeCount, type PlateModel, type Well } from '../yokogawa/types';
import { renderPlateMap, type PlateMap } from './plate-map';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Write prose that may contain `backticked` spans, rendering those as `code`.
 *
 * The copy stays readable where it is written, and the page never shows a
 * stray backtick — which `textContent` alone would.
 */
function setProse(node: HTMLElement, text: string): void {
  node.replaceChildren(
    ...text.split('`').map((part, index) => {
      if (index % 2 === 0) return document.createTextNode(part);
      const code = document.createElement('code');
      code.textContent = part;
      return code;
    }),
  );
}

export function startApp(): void {
  const dropzone = element<HTMLElement>('dropzone');
  const status = element<HTMLElement>('status');
  const datasetSection = element<HTMLElement>('dataset');
  const datasetName = element<HTMLElement>('dataset-name');
  const datasetFacts = element<HTMLDListElement>('dataset-facts');
  const datasetChannels = element<HTMLElement>('dataset-channels');
  const plateLegend = element<HTMLElement>('plate-legend');
  const plateContainer = element<HTMLElement>('plate');
  const openPlate = element<HTMLButtonElement>('open-plate');
  const closeDataset = element<HTMLButtonElement>('close-dataset');
  const about = element<HTMLDialogElement>('about');

  const viewer = element<HTMLElement>('viewer');
  const viewerFrame = element<HTMLIFrameElement>('viewer-frame');
  const viewerTitle = element<HTMLElement>('viewer-title');
  const viewerOpen = element<HTMLAnchorElement>('viewer-open');
  const viewerBack = element<HTMLButtonElement>('viewer-back');
  const viewerSelect = element<HTMLSelectElement>('viewer-select');

  let busy = false;
  let current: Dataset | null = null;
  let plateMap: PlateMap | null = null;

  /* ------------------------------------------------------------ rendering */

  function setStatus(
    headline: string,
    options: { detail?: string; error?: boolean } = {},
  ): void {
    status.replaceChildren();
    status.hidden = false;
    status.classList.toggle('is-error', Boolean(options.error));

    const heading = document.createElement('p');
    heading.className = 'status-headline';
    heading.textContent = headline;
    status.append(heading);

    if (options.detail) {
      const detail = document.createElement('p');
      setProse(detail, options.detail);
      status.append(detail);
    }
  }

  function setProgress(text: string): void {
    let line = status.querySelector<HTMLElement>('.status-progress');
    if (!line) {
      line = document.createElement('p');
      line.className = 'status-progress';
      status.append(line);
    }
    line.textContent = text;
  }

  function renderNotes(notes: string[]): void {
    if (notes.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'notes';
    for (const note of notes) {
      const item = document.createElement('li');
      setProse(item, note);
      list.append(item);
    }
    status.append(list);
  }

  function fact(term: string, value: string): HTMLElement {
    const wrapper = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrapper.append(dt, dd);
    return wrapper;
  }

  /** A compact "6 × 6" when every well was imaged the same way, else a count. */
  function gridSummary(model: PlateModel): string {
    const shapes = new Set(model.wells.map((well) => `${well.gridRows} × ${well.gridColumns}`));
    return shapes.size === 1 ? [...shapes][0] : `${shapes.size} different grids`;
  }

  function renderDataset(dataset: Dataset): void {
    const { model } = dataset;
    datasetName.textContent = `${model.folder}${model.name && model.name !== model.folder ? ` · ${model.name}` : ''}`;

    const imagedPositions = model.plate.rows * model.plate.columns;
    datasetFacts.replaceChildren(
      fact('Wells', `${model.wells.length} of ${imagedPositions}`),
      fact('Fields of view per well', gridSummary(model)),
      fact('Channels', String(model.sizeC)),
      fact('z planes', String(Math.max(...model.wells.map((well) => well.sizeZ)))),
      fact('Pixel size', `${model.spacing.x.toFixed(3)} µm`),
      fact('TIFF planes', planeCount(model).toLocaleString()),
    );

    datasetChannels.replaceChildren(
      ...model.channels.map((channel) => {
        const swatch = document.createElement('span');
        swatch.className = 'channel-swatch';
        const dot = document.createElement('i');
        dot.style.background = `#${channel.color}`;
        const label = document.createElement('span');
        const wavelength = channel.emission ? ` · ${channel.emission} nm` : '';
        label.textContent = `${channel.name}${wavelength}`;
        swatch.append(dot, label);
        return swatch;
      }),
    );

    plateLegend.textContent =
      `${plural(model.wells.length, 'well')} imaged, ` +
      `${plural(fieldCount(model), 'field of view', 'fields of view')} in all. ` +
      'Click a well to open it.';

    plateMap = renderPlateMap(plateContainer, model, (well) => show([well]));
    datasetSection.hidden = false;

    viewerSelect.replaceChildren(
      new Option(`Whole plate (${model.wells.length} wells)`, ''),
      ...model.wells.map((well) => new Option(`Well ${well.id}`, well.id)),
    );
  }

  /* ---------------------------------------------------------------- about */

  // Reachable from the page and from inside the viewer, which covers it. A
  // modal dialog is drawn in the browser's top layer, so it lands above the
  // viewer overlay without either knowing about the other.
  for (const id of ['about-open', 'viewer-about']) {
    element<HTMLButtonElement>(id).addEventListener('click', () => about.showModal());
  }
  element<HTMLButtonElement>('about-close').addEventListener('click', () => about.close());

  // A modal dialog covers the whole layer, so a click reaches the dialog
  // element itself only when it landed on the backdrop around the panel.
  about.addEventListener('click', (event) => {
    if (event.target === about) about.close();
  });

  /* --------------------------------------------------------------- viewer */

  function show(wells: Well[]): void {
    if (!current) return;
    const { model } = current;
    const url = viewerUrl(current.id, model, wells);
    const label =
      wells.length === 1
        ? `Well ${wells[0].id}`
        : `${model.folder}: ${plural(wells.length, 'well')}`;

    viewerTitle.textContent = label;
    viewerOpen.href = url;
    viewerFrame.src = url;
    viewerSelect.value = wells.length === 1 ? wells[0].id : '';
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    plateMap?.setCurrent(wells.length === 1 ? wells[0].id : null);
  }

  function closeViewer(): void {
    viewer.hidden = true;
    // Drop the frame so a hidden Neuroglancer stops holding a WebGL context
    // and reading chunks in the background.
    viewerFrame.removeAttribute('src');
    document.body.style.overflow = '';
  }

  viewerBack.addEventListener('click', closeViewer);
  document.addEventListener('keydown', (event) => {
    // Escape closes the About panel first; it is what the key is for while it
    // is open, and closing the viewer underneath it would be a surprise.
    if (event.key === 'Escape' && !viewer.hidden && !about.open) closeViewer();
  });

  viewerSelect.addEventListener('change', () => {
    if (!current) return;
    const id = viewerSelect.value;
    const wells = id
      ? current.model.wells.filter((well) => well.id === id)
      : current.model.wells;
    if (wells.length > 0) show(wells);
  });

  openPlate.addEventListener('click', () => {
    if (current) show(current.model.wells);
  });

  closeDataset.addEventListener('click', async () => {
    await removeAllDatasets();
    current = null;
    plateMap = null;
    datasetSection.hidden = true;
    closeViewer();
    setStatus('Measurement closed.', {
      detail: 'Its virtual OME-Zarr plate no longer resolves.',
    });
  });

  /* ------------------------------------------------------------ main flow */

  function setBusy(value: boolean): void {
    busy = value;
    dropzone.classList.toggle('is-busy', value);
  }

  async function open(handle: FileSystemDirectoryHandle): Promise<void> {
    setBusy(true);
    try {
      await ensureServiceWorker();

      // One dataset at a time: a second drop replaces the first rather than
      // accumulating handles the user cannot see or revoke.
      await removeAllDatasets();
      current = null;
      plateMap = null;
      datasetSection.hidden = true;

      setStatus(`Reading ${handle.name}…`);
      const model = await loadPlateModel(handle, setProgress);

      setProgress('Sampling one field per channel for contrast…');
      // Yield once so the progress line paints before the reads start.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await estimateContrast(handle, model, (channel) =>
        setProgress(`Sampling contrast, channel ${channel + 1} of ${model.sizeC}…`),
      );

      const dataset = await createDataset(handle, model);
      current = dataset;

      setStatus(
        `${plural(model.wells.length, 'well')} ready.`,
        {
          detail:
            'The measurement is served as a virtual OME-Zarr plate. Nothing was copied or converted.',
        },
      );
      renderNotes(model.notes);
      renderDataset(dataset);
      datasetSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      if (error instanceof ServiceWorkerUnavailableError) {
        setStatus('Cannot serve local files', { detail: error.message, error: true });
      } else {
        setStatus('This folder could not be opened', {
          detail: error instanceof Error ? error.message : String(error),
          error: true,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function run(extraction: DropExtraction): Promise<void> {
    const { directories, files, problems } = extraction;
    if (directories.length === 0) {
      setStatus('No folder to open', {
        detail:
          files.length > 0
            ? 'A CQ3000 measurement is a folder, not a single file. Drop the folder holding the `.ome.xml`.'
            : 'Nothing readable was dropped.',
        error: true,
      });
      renderNotes(problems);
      return;
    }
    if (directories.length > 1) {
      setStatus('Only the first folder was opened', {
        detail: 'One measurement at a time. Drop another to replace it.',
      });
    }
    await open(directories[0]);
  }

  /* --------------------------------------------------------------- events */

  // `dragover` must be cancelled for a drop to be delivered at all.
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragenter', () => dropzone.classList.add('is-over'));
  dropzone.addEventListener('dragleave', (event) => {
    // Ignore the leave events fired when crossing into a child element.
    if (!dropzone.contains(event.relatedTarget as Node | null)) {
      dropzone.classList.remove('is-over');
    }
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    if (busy || !event.dataTransfer) return;

    if (!isDropSupported()) {
      setStatus('This browser cannot hand over dropped folders', {
        detail:
          'The viewer needs the File System Access API (getAsFileSystemHandle), which today means a Chromium-based browser such as Chrome or Edge.',
        error: true,
      });
      return;
    }

    // Must be called before any await: the item list is only valid during this
    // event's dispatch.
    void extractHandles(event.dataTransfer).then(run);
  });

  const browse = element<HTMLButtonElement>('browse');
  if (!isDirectoryPickerSupported()) {
    browse.hidden = true;
  } else {
    browse.addEventListener('click', async () => {
      if (busy) return;
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await window.showDirectoryPicker!({ mode: 'read', id: 'cq3000-viewer' });
      } catch {
        return; // The picker was dismissed.
      }
      await open(handle);
    });
  }

  /* ---------------------------------------------------------------- start */

  void (async () => {
    try {
      await ensureServiceWorker();
    } catch (error) {
      setStatus('Cannot serve local files', {
        detail: error instanceof Error ? error.message : String(error),
        error: true,
      });
      return;
    }

    // Handles survive a reload but their permission grant usually does not, so
    // clear out anything we can no longer read rather than showing a plate map
    // whose every chunk would 403.
    const dropped = await pruneUnreadableDatasets();
    const [surviving] = await listDatasets();

    if (surviving) {
      // The grant did survive — reopening costs nothing, since the model was
      // stored alongside the handle and no pixels are read to show the plate.
      current = surviving;
      setStatus(`Reopened ${surviving.name}.`, {
        detail: 'The folder is still readable, so the plate is ready again.',
      });
      renderDataset(surviving);
    } else if (dropped > 0) {
      setStatus('The dataset from the previous session was closed.', {
        detail:
          'Browsers do not carry folder permissions across a reload. Drop it again to continue.',
      });
    }
  })();
}
