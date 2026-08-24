import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const DIST = new URL('./dist/', import.meta.url);
const BASE = '/cq3000/';
const REPRO = `${BASE}_repro.js`;
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm' };
const built = await esbuild.build({ entryPoints:['/tmp/diag/repro.ts'], bundle:true, format:'esm', target:'esnext', write:false,
  alias:{ '@src': fileURLToPath(new URL('./src', import.meta.url)), '@tests': fileURLToPath(new URL('./tests', import.meta.url)) } });
const code = built.outputFiles[0].text;
const server = createServer(async (req,res)=>{
  const p = decodeURIComponent(new URL(req.url,'http://x').pathname);
  if (p===REPRO){res.writeHead(200,{'Content-Type':'text/javascript'}).end(code);return;}
  if (!p.startsWith(BASE)){res.writeHead(404).end();return;}
  let rel=p.slice(BASE.length); if(rel===''||rel.endsWith('/'))rel+='index.html'; rel=normalize(rel);
  try{const b=await readFile(join(fileURLToPath(DIST),rel));res.writeHead(200,{'Content-Type':T[extname(rel)]??'application/octet-stream','Cache-Control':'no-store'}).end(b);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}${BASE}`;
const browser = await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'],defaultViewport:{width:1280,height:900}});
const page = await browser.newPage();
page.on('console',m=>{ if(m.type()==='error') console.log('  console:', m.text().slice(0,200)); });
page.on('pageerror',e=>console.log('  pageerror:',String(e).slice(0,200)));
await page.goto(base,{waitUntil:'networkidle0'});
await page.waitForFunction(()=>navigator.serviceWorker.controller!==null,{timeout:20000});
await mkdir('/tmp/diag/shots',{recursive:true});
for (const which of ['well','plate']) {
  const info = await page.evaluate(async(u,w)=>{const m=await import(u);window.__r=m;return m.setUp(w);},REPRO,which);
  console.log(`--- ${which}: cell ${info.cell}, ${info.levels} levels, window`, info.window);
  const name = which, url = info.url;
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.viewer?.layerManager.managedLayers.length>=4 &&
    window.viewer.layerManager.managedLayers.every(l=>l.layer?.dataSources?.[0]?.loadState),{timeout:60000,polling:250}).catch(()=>console.log('  layers did not settle'));
  await new Promise(r=>setTimeout(r,6000));
  const st = await page.evaluate(()=>{
    const v=window.viewer;
    const sp=v.navigationState.pose.position.coordinateSpace.value;
    return {
      layers: v.layerManager.managedLayers.map(l=>({n:l.name, arch:l.archived===true, err:l.layer?.dataSources?.[0]?.loadState?.error?.message})),
      zoom: v.navigationState.zoomFactor.value,
      pos: Array.from(v.navigationState.pose.position.value),
      names: sp.names, scales: Array.from(sp.scales),
      lower: Array.from(sp.bounds.lowerBounds), upper: Array.from(sp.bounds.upperBounds),
      shaders: v.layerManager.managedLayers.map(l=>{
        const c = l.layer?.shaderControlState?.value;
        if(!c) return null;
        const contrast = c.get('contrast'); const color = c.get('color');
        return { range: contrast?.trackable?.value?.range, window: contrast?.trackable?.value?.window, color: color?.trackable?.value && Array.from(color.trackable.value) };
      }),
    };
  });
  console.log(name, JSON.stringify(st));
  await writeFile(`/tmp/diag/shots/${name}.png`, await page.screenshot());
  await page.goto(base,{waitUntil:'networkidle0'});
}
await browser.close(); server.close();
