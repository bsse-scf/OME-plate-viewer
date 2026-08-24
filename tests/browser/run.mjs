/**
 * End-to-end in real Chrome.
 *
 * `npm test` covers the reader and the HTTP layer in Node, which is most of
 * the logic but none of the integration: the Service Worker, IndexedDB
 * carrying a directory handle across realms, and Neuroglancer actually
 * drawing the result. This runs all three.
 *
 * It runs against the *production* build, served from a subpath, so the
 * GitHub Pages deployment shape — a worker whose scope is `/<repo>/` and a
 * namespace of `/<repo>/_zarr/...` — is covered too. The page-side harness is
 * bundled separately and served beside it, so nothing test-only ends up in
 * `dist/`.
 *
 * Setting `CQ3000_DATASETS` adds a pass over real acquisitions, dropped onto
 * the page the way a user drops them — the one path a synthetic fixture in
 * origin-private storage cannot stand in for, and the one where a plate that
 * loads its metadata but none of its pixels would show up.
 *
 * Requires Chrome. `CHROME_PATH` overrides the default.
 */
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import * as esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { createServer as createViteServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const DATASETS = (process.env.CQ3000_DATASETS ?? '').split(':').filter(Boolean);
const DIST = new URL('../../dist/', import.meta.url);
const SHOTS = new URL('screenshots/', import.meta.url);

/** Deployed under a subpath, the way GitHub Pages serves a project site. */
const BASE = '/cq3000/';
/** Where the separately bundled page-side harness is served from. */
const HARNESS = `${BASE}_harness.js`;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/**
 * Serve `dist/` under {@link BASE}, plus the harness bundle.
 *
 * A plain static server rather than `vite preview`: the point is to serve
 * exactly the files that would be published, from a subpath, with no dev-time
 * transformation in the way.
 */
async function serve() {
  const harness = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('harness.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    write: false,
  });
  const harnessCode = harness.outputFiles[0].text;

  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (path === HARNESS) {
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.js'] });
      response.end(harnessCode);
      return;
    }
    if (!path.startsWith(BASE)) {
      response.writeHead(404).end('not found');
      return;
    }

    let relative = path.slice(BASE.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    relative = normalize(relative);
    if (relative.startsWith('..')) {
      response.writeHead(400).end('bad path');
      return;
    }
    const file = join(fileURLToPath(DIST), relative);
    try {
      const bytes = await readFile(file);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        // The worker sits at the deployment root and claims only its own
        // directory, which is all it needs here.
        'Cache-Control': 'no-store',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const failures = [];
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

/* ---------------------------------------------------------------- imagery */

/**
 * Decode a non-interlaced 8-bit PNG far enough to look at its pixels.
 *
 * Chrome's screenshots are the only images this has to read, and the point is
 * only to tell "Neuroglancer drew the data" from "Neuroglancer drew nothing",
 * which does not justify a dependency.
 */
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];

  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const colourType = bytes[at + 8 + 9];
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
      if (bytes[at + 8 + 8] !== 8 || channels === undefined) {
        throw new Error('unsupported PNG');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Fraction of pixels that are not the viewer's black background. */
function litFraction(image) {
  const { data, channels } = image;
  let lit = 0;
  const pixels = data.length / channels;
  for (let i = 0; i < pixels; i += 1) {
    const base = i * channels;
    if (data[base] > 12 || data[base + 1] > 12 || data[base + 2] > 12) lit += 1;
  }
  return lit / pixels;
}

/* ------------------------------------------------------------- the viewer */

/**
 * Wait until every layer has resolved its data source.
 *
 * Times out rather than throwing, so a viewer that never comes up is reported
 * alongside its layer state instead of aborting the run with a stack trace.
 */
async function waitForLayers(page, expected) {
  try {
    await page.waitForFunction(
    (count) => {
        const viewer = window.viewer;
        if (!viewer) return false;
        const layers = viewer.layerManager.managedLayers;
        if (layers.length < count) return false;
        return layers.every((managed) => {
          const state = managed.layer?.dataSources?.[0]?.loadState;
          return state !== undefined && state.error === undefined;
        });
      },
      { timeout: 60000, polling: 250 },
      expected,
    );
  } catch {
    console.log('  ...   layers did not settle within 60s');
  }
}

async function layerReport(page) {
  return page.evaluate(() => {
    const viewer = window.viewer;
    if (!viewer) return { layers: [], layout: null, messages: ['window.viewer is undefined'] };
    return {
      layers: viewer.layerManager.managedLayers.map((managed) => ({
        name: managed.name,
        type: managed.layer?.type,
        archived: managed.archived === true,
        error: managed.layer?.dataSources?.[0]?.loadState?.error?.message,
      })),
      layout: viewer.layout.toJSON(),
      messages: Array.from(document.querySelectorAll('.status-message, .neuroglancer-status-message'))
        .map((node) => node.textContent)
        .filter(Boolean),
    };
  });
}

async function shoot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const file = new URL(`${name}.png`, SHOTS);
  const bytes = await page.screenshot({ type: 'png' });
  await writeFile(file, bytes);
  return { path: fileURLToPath(file), image: decodePng(bytes) };
}

/**
 * Drop a folder on the page, the way a user does.
 *
 * Chrome builds the same `DataTransfer` a real drag produces, so the page's
 * `getAsFileSystemHandle()` yields a genuine directory handle — which is what
 * makes this worth doing at all.
 */
async function dropFolder(page, path) {
  const zone = await page.$('#dropzone');
  const box = await zone.boundingBox();
  const cdp = await page.createCDPSession();
  await cdp.send('Input.setInterceptDrags', { enabled: true });

  const data = {
    items: [{ mimeType: 'text/uri-list', data: `file://${path}` }],
    files: [path],
    dragOperationsMask: 1,
  };
  const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, ...at, data, modifiers: 0 });
  }
  await cdp.detach();
}

/** Wait for the viewer overlay's frame to have a Neuroglancer with layers. */
async function viewerFrame(page, timeout) {
  await page.waitForFunction(
    () => {
      const viewer = document.getElementById('viewer');
      return viewer !== null && !viewer.hidden;
    },
    { timeout: 20000 },
  );
  const frame = await (await page.$('#viewer-frame')).contentFrame();
  await frame.waitForFunction(() => window.viewer?.layerManager.managedLayers.length > 0, {
    timeout,
    polling: 500,
  });
  return frame;
}

/** The whole real-acquisition pass, for one measurement folder. */
async function checkAcquisition(page, base, path, chunkFailures) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  console.log(`\nreal acquisition — ${name}`);

  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 20000 });
  chunkFailures.length = 0;

  await dropFolder(page, path);
  await page.waitForFunction(
    () => {
      const section = document.getElementById('dataset');
      return section !== null && !section.hidden;
    },
    { timeout: 600000, polling: 500 },
  );

  const summary = await page.evaluate(() => ({
    facts: document.getElementById('dataset-facts').innerText.replace(/\n/g, ' '),
    wells: document.querySelectorAll('.well.is-imaged').length,
    channels: document.querySelectorAll('.channel-swatch').length,
  }));
  console.log(`  ${summary.facts}`);
  check(summary.wells > 0, 'the drop yields a readable plate', `${summary.wells} wells`);
  check(summary.channels > 0, 'the channels are read');

  // One well, which is the cheap path and should fill in almost at once.
  await page.evaluate(() => document.querySelector('.well.is-imaged').click());
  const wellView = await viewerFrame(page, 120000);
  const wellLayers = await wellView.evaluate(() =>
    window.viewer.layerManager.managedLayers.map((managed) => ({
      name: managed.name,
      error: managed.layer?.dataSources?.[0]?.loadState?.error?.message,
    })),
  );
  check(
    wellLayers.every((layer) => layer.error === undefined),
    'every layer of a real well loads',
    wellLayers.map((layer) => layer.error).filter(Boolean).join('; '),
  );

  await new Promise((resolve) => setTimeout(resolve, 20000));
  const wellShot = await shoot(page, `real-${name}-well`);
  const wellLit = litFraction(wellShot.image);
  // The failure this guards is a plate whose metadata is right — colours,
  // layout, layer names — and whose pixels never arrive.
  check(wellLit > 0.02, 'a real well draws its pixels', `${(wellLit * 100).toFixed(1)}% lit`);
  console.log(`  screenshot: ${wellShot.path}`);

  // Then the whole plate, which streams.
  await page.evaluate(() => document.getElementById('viewer-back').click());
  await page.evaluate(() => document.getElementById('open-plate').click());
  await viewerFrame(page, 120000);
  await new Promise((resolve) => setTimeout(resolve, 45000));
  const plateShot = await shoot(page, `real-${name}-plate`);
  const plateLit = litFraction(plateShot.image);
  check(plateLit > 0.005, 'a real plate draws its pixels', `${(plateLit * 100).toFixed(2)}% lit`);
  console.log(`  screenshot: ${plateShot.path}`);

  check(
    chunkFailures.length === 0,
    'no chunk request failed',
    `${chunkFailures.length}, e.g. ${chunkFailures.slice(0, 3).join(', ')}`,
  );
}

/**
 * The development server has to be able to run the chunk worker.
 *
 * Excluding Neuroglancer from Vite's dependency pre-bundling — which its `?raw`
 * imports require — also excludes its CommonJS dependencies, and importing a
 * named export from an unbundled one throws. When that happens inside the
 * *chunk worker*, the failure is close to silent: the viewer starts, the layers
 * resolve their metadata, the colours and the plate layout are right, and only
 * the pixels never arrive. So this loads the worker's module graph and reports
 * what it could not import.
 */
async function checkDevServer() {
  console.log('\ndevelopment server');
  const vite = await createViteServer({ logLevel: 'error' });
  await vite.listen();
  const base = `http://localhost:${vite.httpServer.address().port}/`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 900, height: 600 },
  });

  try {
    const page = await browser.newPage();
    await page.goto(`${base}neuroglancer/index.html`, { waitUntil: 'networkidle0' });
    const result = await page.evaluate(async (workerUrl) => {
      // Loaded from a worker of our own, because a failure in Neuroglancer's
      // reports nothing useful — an `error` event with an empty message.
      const source = `
        (async () => {
          try {
            await import(${JSON.stringify(workerUrl)});
            postMessage({ ok: true });
          } catch (error) {
            postMessage({ ok: false, message: String(error?.message ?? error) });
          }
        })();
      `;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, message: 'timed out' }), 60000);
        const done = (value) => { clearTimeout(timer); worker.terminate(); resolve(value); };
        // Neuroglancer's own modules post messages once they load, and any
        // message at all means the graph evaluated.
        worker.onmessage = (event) => done(event.data?.ok === false ? event.data : { ok: true });
        worker.onerror = (event) => done({ ok: false, message: event.message || 'worker failed to load' });
      });
    }, `${base}node_modules/neuroglancer/lib/chunk_worker.bundle.js?worker_file&type=module`);

    check(result.ok, "Neuroglancer's chunk worker loads in dev", result.message ?? '');
  } finally {
    await browser.close();
    await vite.close();
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`No Chrome at ${CHROME}. Set CHROME_PATH.`);
    process.exit(1);
  }

  if (!existsSync(DIST)) {
    console.error('No dist/. Run `npm run build` first.');
    process.exit(1);
  }

  const { server, origin } = await serve();
  const base = `${origin}${BASE}`;
  console.log(`serving dist/ at ${base}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    // Group-level probes for `.zarray` and `zarr.json` are how a Zarr reader
    // asks "is this an array or a group?", so only chunk keys count as
    // failures here.
    const chunkFailures = [];
    page.on('response', (response) => {
      const url = response.url();
      if (response.status() < 400 || !url.includes('_zarr/')) return;
      if (/\/\d+(\.\d+)+$/.test(url)) chunkFailures.push(`${response.status()} ${url.slice(-60)}`);
    });
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    console.log('\nlanding page');
    await page.goto(base, { waitUntil: 'networkidle0' });
    check(
      await page.evaluate(() => document.title),
      'the page loads',
    );
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
      timeout: 20000,
    });
    check(true, 'the service worker claims the page');
    check(
      await page.$('#dropzone') !== null && await page.$('#about') !== null,
      'the drop target and About panel are present',
    );

    console.log('\nreading a synthetic acquisition');
    const harness = await page.evaluate(async (url) => {
      const module = await import(url);
      window.__harness = module;
      return module.setUp();
    }, HARNESS);
    check(harness.wells.length === 2, 'both wells are found', harness.wells.join(', '));
    check(harness.channels.length === 2, 'both channels are found');
    check(harness.levels === 3, 'the pyramid has three levels', String(harness.levels));

    const attributes = await page.evaluate(
      async (url) => (await fetch(`${url}.zattrs`)).json(),
      harness.wellRoot,
    );
    check(
      attributes.multiscales?.[0]?.version === '0.4',
      'the worker serves OME-NGFF 0.4 multiscales',
    );
    check(
      attributes.omero?.channels?.length === 2 &&
        attributes.omero.channels[0].color === '00FFFF',
      'omero channel metadata survives the round trip',
    );
    check(
      attributes.omero.channels.every((channel) => channel.window.end < 65535),
      'auto-contrast narrowed the display range',
      JSON.stringify(attributes.omero.channels.map((c) => c.window)),
    );

    const chunkProblem = await page.evaluate(
      (value) => window.__harness.verifyChunk(value),
      harness,
    );
    check(chunkProblem === null, 'a chunk read through the worker matches the source', chunkProblem ?? '');

    console.log('\nneuroglancer — one well');
    await page.goto(harness.singleWellUrl, { waitUntil: 'domcontentloaded' });
    await waitForLayers(page, 2);
    const single = await layerReport(page);
    if (single.messages.length > 0) console.log(`  note  ${single.messages.join(' | ')}`);
    check(
      single.layers.length === 2,
      'the channel axis is split into one layer per channel',
      single.layers.map((layer) => layer.name).join(' | '),
    );
    check(
      single.layers.every((layer) => layer.name.startsWith('A1')),
      'each layer is named after the well it shows',
      single.layers.map((layer) => layer.name).join(' | '),
    );
    check(
      single.layers.every((layer) => layer.error === undefined),
      'no layer reported a load error',
      single.layers.map((layer) => layer.error).filter(Boolean).join('; '),
    );
    check(
      single.layout === 'xy',
      'the viewer opens on a single xy panel, depth or not',
      String(single.layout),
    );
    check(
      (await page.$('.neuroglancer-layer-panel')) === null,
      'the layer bar is hidden',
    );
    check(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('.neuroglancer-side-panel')).every(
          (panel) => panel.offsetParent === null,
        ),
      ),
      'no side panel covers the image',
    );
    const framing = await page.evaluate(() => {
      const viewer = window.viewer;
      const space = viewer.navigationState.pose.position.coordinateSpace.value;
      const { lowerBounds, upperBounds } = space.bounds;
      const extents = space.names.map((name, i) => ({ name, size: upperBounds[i] - lowerBounds[i] }));
      const panel = document.querySelector('.neuroglancer-panel');
      return {
        zoom: viewer.navigationState.zoomFactor.value,
        widest: Math.max(...extents.filter((e) => e.name === 'x' || e.name === 'y').map((e) => e.size)),
        panel: panel ? Math.min(panel.clientWidth, panel.clientHeight) : 0,
      };
    });
    // The opening view should show most of the data, not a corner of it.
    const shown = framing.widest / framing.zoom;
    check(
      shown > framing.panel * 0.3 && shown < framing.panel * 1.6,
      'the opening view is framed on the data',
      `${Math.round(shown)} px of data across a ${framing.panel} px panel`,
    );

    // Give the renderer a couple of frames to draw the chunks it has fetched.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const wellShot = await shoot(page, 'one-well');
    const wellLit = litFraction(wellShot.image);
    check(wellLit > 0.05, 'the well is actually drawn', `${(wellLit * 100).toFixed(1)}% lit`);
    console.log(`  screenshot: ${wellShot.path}`);

    console.log('\nneuroglancer — whole plate');
    await page.goto(harness.wholePlateUrl, { waitUntil: 'domcontentloaded' });
    await waitForLayers(page, 2);
    const plate = await layerReport(page);
    if (plate.messages.length > 0) console.log(`  note  ${plate.messages.join(' | ')}`);
    check(
      plate.layers.length === 2,
      'the plate is two layers, not two per well',
      plate.layers.map((layer) => layer.name).join(' | '),
    );
    check(
      plate.layers.every((layer) => layer.error === undefined),
      'the multi-source layer loaded every well',
      plate.layers.map((layer) => layer.error).filter(Boolean).join('; '),
    );

    await new Promise((resolve) => setTimeout(resolve, 4000));
    const plateShot = await shoot(page, 'whole-plate');
    const plateLit = litFraction(plateShot.image);
    check(plateLit > 0.005, 'the plate is actually drawn', `${(plateLit * 100).toFixed(2)}% lit`);
    console.log(`  screenshot: ${plateShot.path}`);

    console.log('\nback on the landing page');
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const section = document.getElementById('dataset');
      return section !== null && !section.hidden;
    }, { timeout: 20000 });
    const summary = await page.evaluate(() => ({
      name: document.getElementById('dataset-name').textContent,
      facts: Array.from(document.querySelectorAll('#dataset-facts div')).map(
        (row) => row.textContent,
      ),
      wells: Array.from(document.querySelectorAll('.well.is-imaged')).map(
        (button) => button.textContent,
      ),
      channels: document.querySelectorAll('.channel-swatch').length,
      options: document.getElementById('viewer-select').options.length,
    }));
    check(
      summary.wells.join(',') === 'A1,B3',
      'the plate map marks the imaged wells',
      summary.wells.join(','),
    );
    check(summary.channels === 2, 'the summary lists both channels');
    check(summary.options === 3, 'the viewer picker offers the plate and each well');
    const landing = await shoot(page, 'landing');
    console.log(`  screenshot: ${landing.path}`);

    await page.evaluate(async (url) => (await import(url)).tearDown(), HARNESS);

    const noise = consoleErrors.filter(
      (text) => !/Failed to load resource|404|not found/i.test(text),
    );
    check(noise.length === 0, 'no unexpected console errors', noise.slice(0, 3).join(' | '));

    for (const path of DATASETS) {
      await checkAcquisition(page, base, path, chunkFailures);
    }
    if (DATASETS.length === 0) {
      console.log('\nreal acquisitions skipped (set CQ3000_DATASETS to include them)');
    }

    console.log('\nthe build itself');
    check(existsSync(new URL('sw.js', DIST)), 'the worker is emitted at the deployment root');
    const bundles = await readFile(new URL('index.html', DIST), 'utf8');
    check(/assets\/portal-.*\.js/.test(bundles), 'the landing page references its bundle');
    // Guards the easy-to-miss `import "neuroglancer"`: without it the bundle is
    // roughly 900 kB and every zarr:// source fails with "Unsupported scheme".
    const assets = await readdir(new URL('assets/', DIST));
    const viewerBundle = assets.find(
      (name) => name.startsWith('neuroglancer-') && name.endsWith('.js'),
    );
    const { size } = await stat(new URL(`assets/${viewerBundle}`, DIST));
    check(
      size > 1_200_000,
      'the Neuroglancer bundle registers its data sources',
      `${Math.round(size / 1024)} kB`,
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  await checkDevServer();

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
