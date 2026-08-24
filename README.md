# Yokogawa CQ3000 In-Browser Viewer

A static web page for looking at **local** Yokogawa CQ3000 high-content
screening data. Drop a measurement folder and the plate opens in
[Neuroglancer][ng] — wells stitched, channels coloured, each one in its place on
the plate.

Nothing is uploaded. There is no backend, no conversion step and no install. The
image data never leaves the machine it is already on: the page serves it to
itself through a Service Worker.

```
        drop a measurement folder
                   │
          read the OME-XML                 src/yokogawa/
                   │
        each well as a virtual
          OME-Zarr image                   src/yokogawa/zarr.ts
                   │
          Service Worker                   src/vfs/
                   │
        <base>_zarr/<dataset>/<well>/…
                   │
            Neuroglancer                   neuroglancer/
```

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # reader and HTTP layer, in Node
npm run test:browser   # end-to-end in real Chrome
npm run build          # -> dist/
```

Requires a Chromium-based browser (see [Limitations](#limitations)).

`test:browser` needs Chrome; `CHROME_PATH` overrides the default
`/usr/bin/google-chrome`.

To run the Node tests against real acquisitions as well:

```bash
CQ3000_DATASETS=/path/to/20260120T172222_20X_W npm test
```

## What to drop

The measurement folder itself — the one holding the `.ome.xml` and the `Image/`
directory:

```
20260120T172222_20X_W/
├─ 00013603.ome.xml
├─ Image/
│  └─ W0014F0001T0001Z001C1.tif …
└─ 10_Greiner_….wpp
```

Click a well on the plate map to open it, or open the whole plate at once. A
single well loads immediately; the plate streams in well by well.

## How it works

A CQ3000 measurement is one XML file describing the plate and a folder of
single-plane TIFFs — tens of thousands of them, hundreds of gigabytes. Nothing
reads that directly.

This page reads the XML, works out where every field of view sits, and presents
each well as a **virtual OME-Zarr image**: metadata generated on demand, chunks
answered by slicing the TIFFs where they already are. Those TIFFs are
uncompressed and contiguous, so a plane is already in the layout a Zarr chunk
wants — serving one is a byte range, not a decode, and serving a reduced one
only reads the rows it samples.

Each well's metadata carries a `translation` putting it at its real position on
the plate, taken from the well pitch in the vendor's plate file, so opening
several wells assembles a plate rather than a pile of images.

`IMPLEMENTATION.md` describes all of it in detail — the grid recovery, the
pyramid, the chunk pipeline, the worker, and the Neuroglancer state.

## Limitations

**Chromium only.** Dropping a folder needs the File System Access API's
`getAsFileSystemHandle()`, which today means Chrome, Edge or another
Chromium browser.

**Secure context required.** Service Workers need `https://` or
`http://localhost`. GitHub Pages serves over HTTPS.

**Uncompressed TIFFs only.** A compressed or tiled plane is reported rather
than decoded.

**Mounts do not survive a reload.** Folder permissions do not carry across one;
drop the folder again.

**Read-only.** No writes, ever. The original data is not modified in any way.

## Deploying

`.github/workflows/deploy.yml` builds and publishes `dist/` on every push to
`main`. Enable Pages for the repository with **Source: GitHub Actions**. The
build uses a relative base, so one build works at an origin root and at a
project subpath like `https://<user>.github.io/<repo>/`.

## Licensing

This is a thin integration layer. Neuroglancer is Apache-2.0 and is consumed as
an unmodified published package.

Built at the [Single Cell Facility][scf] and the Lab Automation Facility,
D-BSSE, ETH Zürich. A sibling of [ome-zarr-portal][portal], which does the same
for data that is already OME-Zarr.

[ng]: https://github.com/google/neuroglancer
[portal]: https://github.com/bsse-scf/ome-zarr-portal
[scf]: https://bsse.ethz.ch/scf/
