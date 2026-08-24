# Implementation

How a dropped CQ3000 folder becomes a plate in Neuroglancer, and why it is
built this way.

```
                    Landing page  (index.html, src/ui/)
                          │
              drop a measurement folder
                          │
                    FileSystemDirectoryHandle
                          │
      ┌───────────────────┴───────────────────┐
      │                                       │
  OME-XML  ──►  plate model
  src/yokogawa/ome-xml.ts
                │  grid.ts, plate.ts, model.ts
                ▼
          PlateModel  ── IndexedDB ──►  Service Worker
          (geometry + file names)       src/vfs/sw.ts
                                              │
                                    virtual OME-Zarr images
                                    src/yokogawa/zarr.ts
                                    src/yokogawa/tiff.ts, chunk.ts
                                              │
                            <base>_zarr/<dataset>/<well>/<level>/t.c.z.y.x
                                              │
                                        Neuroglancer
                                   neuroglancer/index.html
```

Nothing is uploaded, copied, converted or written. The dataset folder is opened
read-only and every byte the viewer shows is sliced out of the TIFF files where
they already sit.

## One deliberate departure from the brief

`AGENTS.md` describes running Python in the browser under Pyodide, which is how
the [multiview-stitcher browser demo][mvs] gets a virtual OME-Zarr into a page,
and which the reference script `qt_reference/yokogawa_neuroglancer.py` builds on.
**This implementation is plain TypeScript instead**, and it is worth saying why.

Nothing in the pipeline needs Python. Parsing the OME-XML, clustering fields
onto their grid, generating OME-Zarr metadata and slicing rows out of an
uncompressed TIFF are all a few hundred lines in either language. What Pyodide
would add is a runtime download of tens of megabytes before the first pixel, a
multi-second start-up on every visit, a second copy of the data on every
Python-to-JavaScript boundary crossing, and a service worker that cannot answer
a chunk request without waking an interpreter. The brief also asks for special
emphasis on memory and performance, and those two asks point in opposite
directions here.

The other half of the brief — the reference architecture of
[ome-zarr-portal][portal]: File System Access, a Service Worker serving
`_local`-style virtual URLs, a bundled unmodified Neuroglancer, the visual
language of the landing page — is followed closely, and much of `src/vfs/` and
`src/ui/styles.css` began as its code.

If Python does become necessary — for registration-based stitching, say, or to
reuse `multiview-stitcher` directly — the seam is narrow. Everything specific to
Yokogawa lives behind `PlateModel` (`src/yokogawa/types.ts`) and the four
functions in `src/yokogawa/zarr.ts`; the worker, the namespace and the viewer do
not know what produced them.

[mvs]: https://multiview-stitcher.github.io/multiview-stitcher/main/browser/
[portal]: https://github.com/bsse-scf/ome-zarr-portal

## What a CQ3000 measurement looks like

```
20260120T172222_20X_W/
├─ 00013603.ome.xml          the plate, its wells, every field and every plane
├─ 00013603_MIP.ome.xml      derived projections; ignored
├─ Image/
│  └─ W0014F0001T0001Z001C1.tif   one 2000 x 2000 uint16 plane per file
└─ Projection/               derived; ignored
```

The example acquisition this was developed against is 30 wells × 36 fields ×
7 z × 4 channels — 30 240 files and 226 GB. The other is 96 wells × 1 field ×
10 z × 1 channel. Both are read the same way.

Two facts about those TIFFs do most of the work:

* They are **uncompressed**, 16-bit, single-sample, little-endian.
* Their strips are written **back to back**, so a plane's pixels are one
  contiguous run starting a few bytes into the file.

That means a plane is already in the layout a Zarr chunk wants. Serving one is a
byte range, not a decode, and serving a *reduced* one only has to read the rows
it samples. Everything below follows from that.

## Reading the metadata

`src/yokogawa/xml.ts` is a small XML reader — a single forward scan with an
explicit stack, no DOM. The browser has `DOMParser`, so this exists for two
other reasons: the OME-XML runs to fourteen megabytes and a hundred thousand
elements, and a full DOM of that costs several times the document for an API
used to read attributes and nothing else; and a parser written here runs in
Node, which is what lets the whole read path be tested against real
acquisitions. It drops namespace prefixes, which is convenient rather than
sloppy — the same field arrives under `bts:` in one vendor file and `icm:` in
another, never ambiguously.

`src/yokogawa/ome-xml.ts` reduces the document to compact structures and throws
the tree away. Two decisions worth noting:

* **Well membership comes from `Plate/Well/WellSample/ImageRef`**, not from the
  images' `W14(R2C2),A1,F3` names. The reference is what the format guarantees;
  the naming is a vendor convention.
* **Planes and `TiffData` are read independently.** Both carry explicit
  `TheZ`/`FirstZ`-style indices, so using them keeps the plane-to-file mapping
  correct even if the document lists them in different orders.

Stage `PositionY` is negated once, here: stage y grows towards the back of the
instrument, image rows grow downwards.

Reading the 13.9 MB OME-XML of the 226 GB acquisition takes about 260 ms.

## Recovering the acquisition grid

A tiled well is acquired on a regular grid, but the fields overlap, so their
pixel offsets do not tile the plane — they cluster around grid lines.
`src/yokogawa/grid.ts` sorts the offsets and starts a new line whenever the gap
exceeds half a field, which is robust for overlaps below ~50 %; then it averages
the offsets on each line and divides the span by the number of gaps to get the
**stride**.

The stride, not the field of view, becomes the chunk size. Each field is
centre-cropped to it, so neighbours abut exactly and a whole well is a single
chunked array with **one field per chunk**. In the example acquisition, 2000 px
fields stepping 453.2 µm at 0.3238 µm/px give a stride of 1400 px — a 30 %
overlap trimmed away.

This is not stitching. Nothing is registered, blended or feathered: the fields
are placed on the grid the microscope drove, which is accurate to the stage's
own repeatability. Seams stay visible where flat-field differences make them
visible, and features run across them continuously.

Trimming to the *grid*, rather than placing each field at its own measured
offset, is deliberate. It costs at most half a stage jitter of accuracy and buys
the property everything else depends on: every chunk is exactly one file, at a
fixed size, at a computable position.

## Placing wells on the plate

Stage positions in the OME-XML are relative to the centre of each well — every
well in a 96-well acquisition reports the same ones — so the wells have to be
spaced out to sit next to each other.

**Not at their physical pitch.** A 9 mm well holding 2.7 mm of imaged area would
put two thirds of a plate view on empty plastic, and the point of looking at a
whole plate is to compare the wells, not to measure the gaps between them. The
pitch is the widest well plus half again: an imaged patch, then a gap of half
its own width, then the next. That keeps the wells clearly apart, keeps the
plate reading as a plate, and keeps the eye on the data. Everything *inside* a
well stays exactly where the stage put it.

This is also why nothing here reads the vendor's plate files. Well pitch, A1
margin and SBS footprints were all needed only to reproduce a spacing the viewer
does not use, and the layout now follows from the data itself.

Two details the geometry does depend on:

* Stage positions name the **centre** of a field of view, so a field's image
  starts half a field earlier — plus the margin the overlap trim removed.
* `PhysicalSizeZ` is written as the stack's range divided by its plane count,
  which is off by `n/(n-1)`: 7.65 µm where the recorded plane positions step by
  8.5. The positions are unambiguous, so **the z step is taken from them**
  whenever there are at least two.

## The virtual OME-Zarr plate

The whole measurement is presented as an OME-Zarr **plate**, laid out the way
the specification says a high-content screening dataset is laid out —
`plate / row / column / field of view` — with metadata generated on demand:

```
.zattrs                        "plate": its rows, columns and wells
A/.zgroup                      a row of the plate
A/1/.zattrs                    "well": the fields of view it holds
A/1/0/.zattrs                  "multiscales" and "omero" — an image
A/1/0/<level>/.zarray          one resolution level
A/1/0/<level>/t.c.z.y.x        one chunk, which is one field of view
```

Writing it as a plate rather than as a heap of images is what makes the well
names in the paths the well names on the bench — `A/1` *is* well A1 — and it
means anything that reads OME-Zarr plates can read this one.

A well's fields of view are assembled into a single image at `0` rather than
published one by one. The specification allows either, since a well holds
however many images it holds, and one image per well is the difference between
a viewer opening thirty-six sources per well and opening one.

Zarr v2 with OME-Zarr 0.4 rather than v3 with 0.5, because that is the
combination Neuroglancer supports for `zarr://` sources, and because a v2 array
with no compressor is the format whose chunk bytes a raw TIFF plane already is.

Axes are `t, c, z, y, x` in micrometres. Each level declares its own `scale` and
`translation`; the translation names the centre of voxel zero, which is the
convention OME-Zarr readers assume, so adding half a voxel per level keeps the
levels registered to each other at their shared corner.

`omero` carries the channel names, the colours decoded from the OME `Color`
attribute, and the display ranges measured by the contrast pass. Neuroglancer
reads all of it.

### Resolution levels

Level *k* is the same crop halved *k* times in y and x, and still one field per
chunk. Level extents are `ceil(cell / 2^k)`, which for a 1400 px stride gives
1400, 700, 350, 175, 88, 44, 22, 11 — eight levels. Because `ceil` is not exact
division, each level declares the scale that makes its extent cover the same
physical size, rather than assuming a clean factor of two. The pyramid stops
when a chunk would be under 8 px: below that the read stops shrinking (the
number of requests per level is fixed at one per field) while the per-request
cost does not.

z is not reduced. Stacks here are 7 to 10 planes, and Neuroglancer only ever
loads the ones it is showing.

## Serving a chunk

`src/yokogawa/chunk.ts` turns one TIFF plane into one chunk:

1. **Trim.** Crop symmetrically to the stride.
2. **Reduce.** Average columns in full — they are already in memory — and
   *sample* rows, at most two source rows per output row. A row is the smallest
   thing worth reading from a file, so this is what makes a coarse level cheap:
   at level 6 a chunk reads 44 rows of a 2000-row plane, about 2 % of it.
3. **Write** in the array's dtype, into a buffer allocated at its final size.

Row blocks close together are merged into one read and far apart are left
separate, which turns the finest levels into a single sequential read and the
coarsest into a handful of small ones.

When the chunk *is* the plane — a well with one field, no overlap to trim, at
level 0 — there is nothing to do at all, and its bytes are a range of the file
(`passthroughRange`): no crop, no reduction, no copy out of the decoded rows.

Measured on the example acquisitions, over a network filesystem:

| level | chunk | time |
| --- | --- | --- |
| 0 | 1400 × 1400 | 31 ms |
| 1 | 700 × 700 | 38 ms |
| 3 | 175 × 175 | 20 ms |
| 5 | 44 × 44 | 6 ms |
| 7 | 11 × 11 | 9 ms |

## The Service Worker

The problem the worker solves is the same one `ome-zarr-portal` solves:
Neuroglancer consumes OME-Zarr over HTTP, and a `FileSystemDirectoryHandle` is
not HTTP. The worker answers same-origin requests by reading the handle
directly.

```
GET|HEAD  <base>_zarr/<dataset-id>/<well>/<level>/<t>.<c>.<z>.<y>.<x>
```

The handle and the plate model are written to IndexedDB (`src/mounts/registry.ts`).
IndexedDB is the important part: `FileSystemHandle` is structured-cloneable, so
storing it there hands the *worker* — not the page — the ability to read files,
which matters because the browser can kill and restart a worker at any moment.
**No file contents are ever stored**, only the handle and the geometry.

`src/vfs/serve.ts` holds the HTTP semantics — path parsing, ranges, status
codes — with no reference to IndexedDB or worker lifecycle, so the whole serving
path can be exercised in Node against a real dataset on disk. `src/vfs/sw.ts`
adds the parts that need a worker:

* **A directory-handle cache.** Every plane shares the `Image/` prefix, so this
  collapses each request's walk to one `getFileHandle` call.
* **A TIFF-directory cache.** Reading one costs two small range reads, and the
  same plane answers several chunks over a session — again at every resolution
  level.
* **Admission control** (`src/vfs/gate.ts`), which is where the viewer's
  responsiveness is won or lost. It has its own section below.

A missing chunk — a gap in the acquisition grid, a z plane outside a field's
stack — is a 404, which Zarr reads as the array's fill value.

## Admission control, and letting go

A single z step asks for hundreds of chunks. On the example acquisition it is
576: thirty-six fields, four channels, and the four resolution levels
Neuroglancer keeps loaded at once. Two things decide how that feels.

**The limit is a budget of bytes, not a count.** A full-resolution chunk holds
about nine megabytes of working set while it is built — the rows it read plus
its own output — and a chunk from the coarse levels a plate view uses holds a
few hundred kilobytes. A fixed count has to be chosen for the expensive case and
then throttles the cheap one, which is the common one. A 96 MB budget admits
about ten of the first and as many of the second as the concurrency ceiling
allows. The cost is estimated from the geometry alone
(`workingSetBytes`), so admission is decided before a file is opened.

**Cancelled chunks stop being read.** Neuroglancer drops the chunks it no longer
needs the moment the view moves, which is what keeps it responsive — but only if
the other side listens. A queue that holds on to cancelled work makes the
requests that replaced it wait behind reads whose results are already being
discarded. Three hundred outstanding full-resolution chunks are 1.7 GB; a
request arriving behind them waited seconds.

The obvious hook does not work. `FetchEvent.request.signal` exists in a Service
Worker and Chrome never aborts it, so a worker that watches it learns nothing —
measured, before and after: 5951 ms against 6377 ms, no difference at all. What
Chrome *does* cancel is the **response stream**. So a chunk's work hangs off
one: the response goes out immediately carrying the length its geometry implies,
the reading happens inside the stream, and `cancel()` aborts it.

Which means **nothing expensive may happen before the response exists**, because
until then there is no stream to cancel. That turned out to matter more than it
sounds: reading the TIFF directory is only two small reads, but with a
viewport's worth of requests arriving together, doing it ahead of the response
left most of them past the point of no return by the time the view moved.
Moving it inside took the same measurement from 32.5 s to 0.55 s.

Measured on the example acquisitions, one request issued behind three hundred
others:

| | cancelled | left running |
| --- | --- | --- |
| 96-well, one field | **552 ms** | 10454 ms |
| 30-well, 36 fields | **483 ms** | 6448 ms |

In the viewer, a second z step made a second and a half into the first — with
576 requests in flight — returns its first data in 0.17 s and all of it within
0.33 s. A single uninterrupted z step went from 10.7 s to 5.9 s on the same
data, which is the byte budget rather than the cancellation: that acquisition
sits on a network filesystem and is bandwidth-bound, so the honest summary is
that concurrency helps a little and not reading unwanted data helps a lot.

Byte ranges and `HEAD` are answered from a finished buffer instead: neither is
on the viewer's path, and both need the whole chunk anyway.

Requests are rejected before touching the filesystem if any segment decodes to
`.`, `..`, an encoded `/`, or a NUL.

## Driving Neuroglancer

Neuroglancer is bundled unmodified from the npm package as a second page in the
build, and driven entirely through its `#!{…}` state fragment. The one thing
that makes local data work is that the sources are same-origin `_zarr/` URLs:
Neuroglancer's `zarr://` source sits on its HTTP key-value store, which needs
`GET`, `HEAD`, byte ranges and honest 404s and nothing else.

Importing the package entry point (`import 'neuroglancer'`) is **required and
easy to miss**: `setupDefaultViewer()` builds the UI but registers nothing, and
without it every source fails with `Unsupported scheme: zarr:` and the bundle is
roughly 900 kB instead of 1.5 MB. `tests/browser/run.mjs` guards against that.

`src/integrations/neuroglancer.ts` builds two shapes of state, and the
difference is the interesting part:

* **One well** is one layer with one source, named after the well.
* **A whole plate** is one layer with *many* sources, one per well.
  Neuroglancer composes a layer's sources in the shared coordinate space, so the
  per-well `translation` is what lays the plate out. Ninety-six wells then cost
  one render layer per channel instead of one per well *and* channel.

Both are `type: "auto"`. On load Neuroglancer splits a layer with a channel axis
into one layer per channel, taking each channel's colour and display range from
`omero` and blending them additively — which is where the channel colours come
from, with no viewer-side configuration.

Three things the state has to say explicitly:

* **Framing.** Neuroglancer's default zoom is one voxel per screen pixel, which
  for a plate means opening on a few hundred micrometres of one well. The state
  declares the axes, the centre of the selection and a `crossSectionScale` that
  fits it.
* **No side panel.** Splitting the channels also makes Neuroglancer open a
  "Shader controls" palette over the image — unless a palette with that query
  already exists, so the state declares one, hidden. It is still one click away
  in the top bar.
* **Black background.** Fluorescence is emission on nothing; Neuroglancer's mid
  grey reads as signal.

The layer bar is hidden with `showLayerPanel: false`.

The layout is always `xy`, a single panel, whether or not the data has depth. A
plate is looked at from above; orthogonal panels of a screening stack spend
three quarters of the window on seven z planes seen edge-on, and z stays a
scroll away in the xy panel. The other layouts are one click away in each
panel's corner.

## The page

`src/ui/app.ts` is the landing-page controller: drop target, progress, dataset
summary, plate map, and the viewer overlay.

The **plate map** (`src/ui/plate-map.ts`) is drawn as the plate looks on the
bench — row letters down the side, column numbers across the top, imaged
positions filled in — because a microplate is a spatial object and a list of
well names is a poor way to find B7. It is also the answer to the one real cost
here: opening a whole plate reads a slice of the entire acquisition, opening one
well reads almost nothing, and clicking a well is both the obvious gesture and
the cheap one.

**Auto-contrast** (`src/yokogawa/contrast.ts`) samples three fields per channel
— those nearest the middle of the most densely tiled well, at mid stack, every
few rows — pools them, and takes percentiles from a histogram. Neuroglancer
would otherwise compute contrast from whatever chunks happen to have loaded,
which on a plate means the range flickering as wells stream in.

**Which percentile matters far more than it looks.** Fluorescence is
long-tailed: on a real DAPI plane the median is 10 counts, the 99th percentile
297 and the maximum 2859. A range taken at the 99.9th percentile stretches over
the tail and leaves the sample itself in the bottom few per cent of it — barely
one pixel in a hundred reaches a quarter brightness, against one in twenty at
the 99th. And because Neuroglancer applies one range to the whole multiscale,
that same choice decides what a plate overview looks like, where the effect is
worse still: measured across the pyramid of a real well, a 99.9th-percentile
range leaves **0.00 %** of the coarsest level above a quarter brightness — a
black plate — where a 99th-percentile range holds it at about 3 % from full
resolution all the way down. The percentile is 99.

**The control has to span the data too.** `omero`'s `window` is the range the
contrast slider covers, and `start`/`end` the setting within it. Left at the
pixel type's own limits, a 16-bit channel whose signal reaches three thousand
gets a slider stretched over sixty-five thousand: every setting within reach of
the mouse looks identical, which reads as the contrast doing nothing at all. The
bounds are taken from the sample's own extremes.

That measurement is also what settles the reducer. Averaging pulls the extreme
maximum of a 128-fold reduction down by a factor of ten, which looks alarming,
but it barely moves the bulk: the fraction of pixels above a quarter brightness
runs 5.20 %, 5.19 %, 5.75 %, 4.89 % from full resolution down to a 128-fold
reduction. A maximum instead takes the same figures to 5.2 %, 8.8 %, 15.9 %,
30.2 % — coarse levels progressively brighter than the data they stand for.
Averaging is what keeps one display range honest at every zoom.

Only one dataset is mounted at a time: a second drop replaces the first rather
than accumulating handles the user cannot see or revoke. A stored dataset that
is still readable is reopened on startup, since the model was stored alongside
the handle and no pixels are read to show a plate — but it carries a version
stamp, and one built by an older version of this code is discarded rather than
reused. A model is not merely a cache of the folder: it holds values derived
from reading it, the display ranges above all, and reusing an old one would
quietly undo an update.

## Costs, and what they buy

Opening **one well** reads one chunk per field per visible channel and z — a few
tens of megabytes at full resolution, less at any coarser level. It is
immediate.

Opening the **whole plate** is the expensive case, and irreducibly so: showing
every well at 1/64 still means touching at least one row per 64, in every file
of the visible z and channels. For the 226 GB example that is around a gigabyte
read once, streamed well by well, and cached by Neuroglancer for the rest of the
session. The pyramid is taken as deep as it usefully goes precisely to keep that
number down; a shallower one would multiply it.

Peak memory is bounded by the admission budget rather than by the dataset: 96 MB
of chunk working set in flight, whatever the zoom. Nothing accumulates between
requests; the only things cached are directory handles and TIFF directories,
both of them a few numbers each.

## Deployment

`.github/workflows/deploy.yml` builds and publishes `dist/` on every push.
Enable Pages with **Source: GitHub Actions**.

The build uses a **relative base**, so one build works at an origin root *and*
at a project subpath like `https://<user>.github.io/<repo>/`. A Service Worker
can only claim a scope at or below its own path, so at a subpath the namespace
is `/<repo>/_zarr/…`. Both sides derive the base at runtime — the worker from
`registration.scope`, the page from the same scope once registered — rather than
baking it in. In development a small Vite middleware serves the worker at
`/sw.js` with a `Service-Worker-Allowed` header, so the registration code is
identical in both modes.

`optimizeDeps.include` names Neuroglancer's CommonJS dependencies through their
importer. Excluding the package to keep its `?raw` imports working also excludes
its dependencies, and left unbundled the CommonJS ones reach the browser as
CommonJS, where importing a named export throws — in dev only, since the
production build converts them.

Subpaths have to be named one by one: pre-bundling `crc-32` does nothing for
`crc-32/crc32c.js`. Getting that wrong is quiet and expensive, because the
module that fails is imported by Neuroglancer's **chunk worker**. The viewer
still starts, the layers still resolve their metadata, the channel colours and
the plate layout are still right, and only the pixels never arrive — while the
worker reports its failure as an `error` event with an empty message. The
browser test loads that worker's module graph in dev and says what it could not
import.

## Layout

```
index.html                  landing page
neuroglancer/index.html     bundled Neuroglancer
src/
  main.ts                   entry
  ui/                       landing page, plate map, styling
  mounts/                   drag-and-drop -> handles -> datasets
  vfs/
    protocol.ts             the page/worker contract
    idb.ts                  a minimal IndexedDB wrapper
    files.ts                opening files inside a dataset folder
    gate.ts                 admission control: a byte budget, and cancellation
    serve.ts                HTTP semantics and the chunk pipeline
    sw.ts                   Service Worker: lifecycle, caches, concurrency
    client.ts               registration, base-path derivation, URLs
  yokogawa/
    xml.ts                  a small XML reader
    ome-xml.ts              the OME-XML, reduced
    plate.ts                row, column and well names
    grid.ts                 fields -> acquisition grid
    model.ts                the plate model
    types.ts                what a model is
    tiff.ts                 TIFF directories and row ranges
    chunk.ts                one plane -> one chunk
    zarr.ts                 the virtual OME-Zarr plate
    contrast.ts             display ranges from one plane per channel
  integrations/
    neuroglancer.ts         viewer state
tests/                      Node tests (`npm test`)
tests/browser/              end-to-end in Chrome (`npm run test:browser`)
```

## Tests

`npm test` bundles the TypeScript tests with esbuild and runs them under
`node --test`. They exercise the reader and the HTTP layer against a synthetic
acquisition written to a temporary directory — a real OME-XML and real
uncompressed TIFFs whose pixel values are a known function of their coordinates,
so a cropped or reduced chunk can be checked arithmetically. A
`FileSystemDirectoryHandle` adapter over `node:fs` (`tests/node-handles.ts`)
means the code under test is the code that runs in the worker.

Setting `CQ3000_DATASETS` to one or more measurement folders adds a pass over
real acquisitions: the model is built, a plane's TIFF directory is checked
against what the fast path assumes, and one chunk is read at every level. The
synthetic fixture pins the arithmetic; this pins the assumptions.

Setting `CQ3000_DATASETS` also adds a real-acquisition pass to the browser run:
the folder is dropped on the page over the DevTools protocol, which builds the
same `DataTransfer` a real drag produces, so the page gets a genuine directory
handle. It then opens a well and the whole plate and checks that pixels actually
reach the screen. That pass exists because everything before it can pass while a
plate loads its metadata — colours, layout, layer names — and none of its
pixels; a fixture in origin-private storage cannot stand in for a dropped
folder, and it was the gap through which exactly that failure once slipped.

`npm run test:browser` drives real Chrome against the production build, served
from a subpath so the GitHub Pages deployment shape is covered too. It writes
the same synthetic acquisition into origin-private storage — an OPFS handle is
an ordinary `FileSystemDirectoryHandle`, so the worker, the reader and the
viewer all take the path they would take for a real folder — reads a chunk back
through the worker and checks it byte for byte, then opens Neuroglancer on one
well and on the plate and asserts that the channels split, the layers resolve,
no panel covers the image, the view is framed on the data, and something was
actually drawn. What it cannot cover is acquiring the folder handle from a
drag-and-drop, which needs a human.

## Limitations

**Chromium only.** Dropping a folder needs
`DataTransferItem.getAsFileSystemHandle()`. Firefox and Safari support the older
`webkitGetAsEntry()`, but it yields `FileSystemEntry` objects that cannot be
structured-cloned into a Service Worker, which is the basis of this design.

**Secure context required.** Service Workers need `https://` or
`http://localhost`.

**Uncompressed TIFFs only.** A compressed or tiled plane is rejected with a
clear error rather than decoded. Every CQ3000 acquisition seen so far writes
uncompressed contiguous strips, and adding a decoder would give up the property
the whole design rests on.

**Mounts do not survive a reload.** Handles persist in IndexedDB but their
permission grant does not, and re-granting needs a user gesture. On startup the
page forgets anything it can no longer read, so you get "drop it again" rather
than a wall of 403s.

**Same-origin exposure.** While a dataset is open, any script on this origin can
read every file under it through `_zarr/` — though only as chunks of the wells
the model describes. Dataset ids are random and unguessable, which prevents
guessing a namespace, but it is not a boundary against code already running on
the page. Use **Close dataset** when finished.

**Read-only.** The worker rejects everything but `GET` and `HEAD`.

**Fields are placed, not registered.** Tiles abut on the acquisition grid. An
acquisition whose stage positions are wrong will produce a montage that is wrong
in the same way.

**Time series are carried but untested.** The model and the arrays have a `t`
axis, and every acquisition available for development has `SizeT = 1`.
