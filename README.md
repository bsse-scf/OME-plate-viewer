# OME Plate Viewer

[![Open the viewer](https://img.shields.io/badge/open-the%20viewer-2f56c8?style=for-the-badge)](https://m-albert.github.io/OME-plate-viewer/)

A static web page for looking at **local** high-content screening plates.

- **No installation.** Open the link above to run the viewer in your browser. There is no
  server and no backend.
- **Your plates stay yours.** Drop a plate folder from your own disk and it is
  read where it sits. Nothing is uploaded, nothing is written, nothing is
  copied, and no converted second copy appears beside your data.
- **For looking at raw OME plate data.** It is a viewer, not a pipeline: point
  it at the raw microscope output and it shows you the plate.

Drop a plate folder and it opens in [Neuroglancer][ng] with the fields of view
assembled into wells, the channels coloured, and each well in its place on the
plate. The image data never leaves the machine it is already on: the page serves
it to itself through a Service Worker.

So far it has been developed and tested against **Yokogawa CQ3000** data. The
reader works from OME-XML metadata alone, so other instruments that write it in
the same shape should follow, but have not been tried.

```
          drop a plate folder
                   │
          read the OME-XML                 src/yokogawa/
                   │
        the plate as a virtual
          OME-Zarr plate                   src/yokogawa/zarr.ts
                   │
          Service Worker                   src/vfs/
                   │
     <base>_zarr/<dataset>/<row>/<col>/…
                   │
            Neuroglancer                   neuroglancer/
```

## What to drop

The plate folder itself: the one holding the `.ome.xml` and the `Image/`
directory.

```
20260120T172222_20X_W/
├─ 00013603.ome.xml
└─ Image/
   └─ W0014F0001T0001Z001C1.tif …
```

Click a well on the plate map to open it, or open the whole plate at once. A
single well loads immediately; the plate streams in well by well.

## How it works

A screening run leaves one XML file describing the plate and a folder of
single-plane TIFFs — tens of thousands of them, hundreds of gigabytes. Nothing
reads that directly.

This page reads the XML, works out where every field of view sits, and presents
the plate as a **virtual OME-Zarr plate** — `plate / row / column / field of
view`, as the specification lays a screen out — with metadata generated on
demand and chunks answered by slicing the TIFFs where they already are. Those
TIFFs are uncompressed and contiguous, so a plane is already in the layout a
Zarr chunk wants: serving one is a byte range, not a decode.

Each well's image carries a `translation` putting it in its place on the plate,
so opening several wells assembles a plate rather than a pile of images.

`IMPLEMENTATION.md` describes all of it in detail: the grid recovery, the chunk
pipeline, the worker, and the Neuroglancer state.

## Limitations

**Chromium only.** Dropping a folder needs the File System Access API's
`getAsFileSystemHandle()`, which today means Chrome, Edge or another
Chromium browser.

**Secure context required.** Service Workers need `https://` or
`http://localhost`. GitHub Pages serves over HTTPS.

**Uncompressed TIFFs only.** A compressed or tiled plane is reported rather
than decoded.

**Full resolution only.** There is no pyramid, so a whole-plate view of a
*tiled* acquisition asks for more than a viewer can hold and fills only part of
the plate. Wells open one at a time regardless, and plates of single-field wells
are unaffected.

**Mounts do not survive a reload.** Folder permissions do not carry across one;
drop the folder again.

**Read-only.** No writes, ever. The original data is not modified in any way.

## Licensing

This is a thin integration layer. Neuroglancer is Apache-2.0 and is consumed as
an unmodified published package.

Built at the [Single Cell Facility][scf] and the Lab Automation Facility,
D-BSSE, ETH Zürich. A sibling of [ome-zarr-portal][portal], which does the same
for data that is already OME-Zarr.

[ng]: https://github.com/google/neuroglancer
[portal]: https://github.com/bsse-scf/ome-zarr-portal
[scf]: https://bsse.ethz.ch/scf/
