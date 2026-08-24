import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { createServer as createViteServer } from 'vite';

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



const DATASET = process.argv[2];
const DIST = new URL('./dist/', import.meta.url);
const BASE = '/cq3000/';
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm' };
const DEV = process.argv.includes('--dev');
let server, base;
if (DEV) {
  server = await createViteServer({ logLevel: 'warn' });
  server.middlewares.use((req, _res, next) => {
    if ((req.url ?? '').includes('_zarr')) console.log('  [reached vite]', req.url.slice(0, 90));
    next();
  });
  await server.listen();
  base = `http://localhost:${server.httpServer.address().port}/`;
} else {
  server = createServer(async (req,res)=>{
    const p = decodeURIComponent(new URL(req.url,'http://x').pathname);
    if (!p.startsWith(BASE)){res.writeHead(404).end();return;}
    let rel=p.slice(BASE.length); if(rel===''||rel.endsWith('/'))rel+='index.html'; rel=normalize(rel);
    try{const b=await readFile(join(fileURLToPath(DIST),rel));res.writeHead(200,{'Content-Type':T[extname(rel)]??'application/octet-stream','Cache-Control':'no-store'}).end(b);}catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${server.address().port}${BASE}`;
}
console.log(DEV ? 'dev server' : 'production build', base);

const browser = await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:true,
  args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'],
  defaultViewport:{width:1400,height:900}});
const page = await browser.newPage();
// Wrap Worker before Neuroglancer runs, so a worker that fails to load says so.
await page.evaluateOnNewDocument(() => {
  const Real = window.Worker;
  window.__workerEvents = [];
  window.Worker = class extends Real {
    constructor(url, options) {
      super(url, options);
      window.__workerEvents.push({ kind: 'created', url: String(url) });
      this.addEventListener('error', (e) =>
        window.__workerEvents.push({ kind: 'error', message: e.message, file: e.filename, line: e.lineno }));
      this.addEventListener('messageerror', () => window.__workerEvents.push({ kind: 'messageerror' }));
    }
  };
});
// Capture everything from every target, including dedicated workers, which is
// where Neuroglancer fetches and decodes chunks.
browser.on('targetcreated', async (target) => {
  try {
    const worker = await target.worker();
    if (!worker) return;
    console.log('  [worker created]', target.url().slice(-70));
  } catch {}
});
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
const failed = new Set();
page.on('response', (r) => { if (r.status() >= 400) failed.add(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => failed.add(`FAILED ${r.failure()?.errorText} ${r.url()}`));
globalThis.__failed = failed;
page.on('workercreated', (w) => {
  console.log('  [worker]', w.url().slice(-70));
});
const cdpAll = await page.createCDPSession();
await cdpAll.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
cdpAll.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
  const s = cdpAll.connection().session(sessionId);
  if (!s) return;
  try {
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    await s.send('Network.enable').catch(() => {});
    s.on('Network.responseReceived', (e) => {
      const url = e.response.url;
      if (!url.includes('_zarr/')) return;
      const key = url.slice(url.lastIndexOf('/') + 1);
      const isChunk = /^\d+(\.\d+)+$/.test(key);
      if (e.response.status >= 400) {
        console.log(`  [${targetInfo.type} ${e.response.status}] ${url.slice(url.indexOf('_zarr'))}`);
      } else if (isChunk) {
        globalThis.__served = (globalThis.__served ?? 0) + 1;
      }
    });
    s.on('Runtime.exceptionThrown', (e) =>
      console.log(`  [${targetInfo.type} exception]`, (e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? '').slice(0, 400)));
    s.on('Log.entryAdded', (e) => {
      if (e.entry.level === 'error') console.log(`  [${targetInfo.type} log]`, e.entry.text.slice(0, 300));
    });
    s.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error') console.log(`  [${targetInfo.type} console]`, e.args.map(a=>a.description??a.value).join(' ').slice(0, 300));
    });
    await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(()=>{});
  } catch (error) {
    console.log('  [attach failed]', String(error).slice(0, 150));
  }
  await s.send('Runtime.runIfWaitingForDebugger').catch(() => {});
});


await page.goto(base,{waitUntil:'networkidle0'});
await page.waitForFunction(()=>navigator.serviceWorker.controller!==null,{timeout:20000});

const zone = await page.$('#dropzone');
const box = await zone.boundingBox();
const cdp = await page.createCDPSession();
await cdp.send('Input.setInterceptDrags', { enabled: true });
const data = { items:[{mimeType:'text/uri-list',data:`file://${DATASET}`}], files:[DATASET], dragOperationsMask:1 };
const at = { x: Math.round(box.x+box.width/2), y: Math.round(box.y+box.height/2) };
const dropStart = Date.now();
for (const type of ['dragEnter','dragOver','drop']) await cdp.send('Input.dispatchDragEvent',{type,...at,data,modifiers:0});
await page.waitForFunction(()=>{const s=document.getElementById('dataset');return s&&!s.hidden;},{timeout:600000,polling:200});
console.log(`drop -> plate map ready: ${((Date.now()-dropStart)/1000).toFixed(1)} s`);

// Ask the worker directly what it thinks of a chunk key.
const probe = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('yokogawa-cq3000-viewer');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const records = await new Promise((res, rej) => {
    const r = db.transaction('datasets', 'readonly').objectStore('datasets').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const record = records[0];
  if (!record) return { error: 'no dataset record' };
  const well = record.model.wells[0];
  const base = new URL(`./_zarr/${record.id}/${well.id}/`, location.href).href;
  const out = { id: record.id, well: well.id, levels: well.levels, base, results: [] };
  for (const key of ['.zgroup', '.zattrs', '0/.zarray', `0/0.0.${Math.floor(well.sizeZ/2)}.0.0`,
                     `${well.levels - 1}/0.0.${Math.floor(well.sizeZ/2)}.0.0`]) {
    const response = await fetch(base + key);
    out.results.push({
      key, status: response.status,
      error: response.headers.get('X-Local-Error'),
      length: response.headers.get('Content-Length'),
      body: response.status >= 400 ? (await response.text()).slice(0, 160) : null,
    });
  }
  return out;
});
console.log('  [probe]', JSON.stringify(probe, null, 1));

for (const which of ['well', 'plate']) {
  const t0 = Date.now();
  if (which === 'well') await page.evaluate(()=>document.querySelector('.well.is-imaged').click());
  else { await page.evaluate(()=>document.getElementById('viewer-back').click());
         await page.evaluate(()=>document.getElementById('open-plate').click()); }

  const frame = await (await page.$('#viewer-frame')).contentFrame();
  await frame.waitForFunction(()=>window.viewer?.layerManager.managedLayers.length>0,{timeout:120000,polling:100});
  console.log(`\n${which}: viewer up at ${((Date.now()-t0)/1000).toFixed(1)} s`);
  await new Promise(r => setTimeout(r, 3000));
  const stats = await frame.evaluate(async () => {
    const manager = window.viewer.dataContext.chunkManager;
    try {
      const raw = await manager.getStatistics();
      const rows = [];
      for (const [source, values] of raw) {
        rows.push({ source: String(source.constructor?.name), values: Array.from(values) });
      }
      return { ok: true, rows: rows.slice(0, 6) };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 200) };
    }
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));
  console.log('  worker events:', JSON.stringify(await frame.evaluate(() => window.__workerEvents ?? 'not wrapped')));
  console.log('  failed requests:');
  for (const f of [...globalThis.__failed].slice(0, 15)) console.log('   ', f.replace(/http:\/\/localhost:\d+/, ''));
  console.log('  layers:', JSON.stringify(await frame.evaluate(() =>
    window.viewer.layerManager.managedLayers.map((m) => ({
      name: m.name,
      ready: m.isReady?.() ?? null,
      loaded: m.layer?.dataSources?.[0]?.loadState !== undefined,
      error: m.layer?.dataSources?.[0]?.loadState?.error?.message?.slice(0, 200),
    })))));

  // What actually reaches the screen, which is the question.
  const deadline = Date.now() + 90000;
  let firstLit = null;
  while (Date.now() < deadline) {
    const shot = decodePng(await page.screenshot({ type: 'png' }));
    let lit = 0;
    const pixels = shot.data.length / shot.channels;
    for (let i = 0; i < pixels; i += 1) {
      const b = i * shot.channels;
      if (shot.data[b] > 12 || shot.data[b + 1] > 12 || shot.data[b + 2] > 12) lit += 1;
    }
    const fraction = lit / pixels;
    const t = (Date.now() - t0) / 1000;
    if (firstLit === null && fraction > 0.02) firstLit = t;
    console.log(`  ${t.toFixed(1).padStart(5)} s: ${(fraction * 100).toFixed(2)}% lit`);
    if (firstLit !== null && t > firstLit + 12) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  -> first image data at ${firstLit === null ? 'never' : firstLit.toFixed(1) + ' s'}` +
    `, chunks served to workers: ${globalThis.__served ?? 0}`);
  globalThis.__served = 0;
}
await browser.close(); await server.close();
