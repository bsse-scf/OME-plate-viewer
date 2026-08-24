# Yokogawa CQ3000 Web Viewer

## Overview

This is a in-browser no-installation viewer for Yokogawa CQ3000 HCS imaging data.

The idea is to have a simple static website that can be hosted on any web server (e.g. github pages) and that allows the user to drag and drop a folder containing Yokogawa CQ3000 HCS data and then visualize it in the browser using neuroglancer.

How does it work?
- It is a static website that can be hosted on any web server (e.g. github pages)
- It uses the File System Access API to read files from the local file system (it has a central drag and drop area for the user to drop a folder containing the data)
- It uses pyodide service workers to run python code in the browser
- It exposes each input well as a virtual OME-Zarr image
- The virtual OME-Zarr images representing the wells contain coordination transform metadata which, next to representing the pixel spacing as a scale, contain a translation component to place the tiles on a common coordinate system representing the whole plate. These transformations are used by neuroglancer to display the wells in their correct positions on the plate. These positions are calculated from the OME metadata and the well names.
- It uses the OME metadata to understand the input data and to create the virtual OME-Zarr images
- It serves these virtual OME-Zarr images over http locally
- It visualizes the OME-Zarr images in the browser using neuroglancer
- It carries its own deployment of neuroglancer with modifications similar to those in https://github.com/bsse-scf/ome-zarr-portal (for hiding bars and 2D/3D default behaviour)

## References

Essentially, except a few differences, this project is a combinatin of the following projects:
- Efficient creation of virtual OME-Zarr images and efficient stitching: local file "./qt_reference/yokogawa_neuroglancer.py"
- File system access and pyodide / OME-Zarr serving and multiprocessing:
  - https://github.com/bsse-scf/ome-zarr-portal
  - https://multiview-stitcher.github.io/multiview-stitcher/main/browser/

## Interface

- Title: "Yokogawa CQ3000 In-Browser Viewer"
- Drag and drop area
- Neuroglancer viewer area
  - no layer panel, no right panel
  - xy layout for 2D data, 4 panel layout for 3D data
- ETH / SCF / LAF logos / github link in the footer
- An expandable "About" section with a short explanation and viewer instructions
- General style: simple, clean, minimalistic, modern, responsive, close to https://github.com/bsse-scf/ome-zarr-portal

## Notes

- The website is hosted on github pages
- In neuroglancer, each source carries the name of the well it represents
- virtual OME-Zarr images carry OMERO channel metadata to allow for proper channel coloring in neuroglancer
- OME-Zarr is only a transactional format for the purpose of visualization in neuroglancer. The original data is not modified in any way.
- Special emphasis needs to be on memory usage and performance, since the data can be very large. The website should be able to handle large datasets without crashing or slowing down too much.
- For memory reduction in neuroglancer, OME-Zarr images should contain different resolution levels (using the same levels as the ones used by multiview-stitcher, with downsampling method to be chosen optimally)
- potentially useful: working with multi-layer sources in neuroglancer
- In the future, more viewers could be added, but for now neuroglancer is the only one
- multi-channel data is supported


## Example data

- /links/shared/scuanalysis/Hierlemann/maria/P2013_Hierlemann_00013603/20260120T172222_20X_W
- /links/shared/scuanalysis/LAF/Sant/P2001_Hierlemann_00013515_with_CV_format/20251027T134435_10X

## Testing

Testing is performed by running the website locally and dropping a folder containing Yokogawa CQ3000 HCS data. The viewer should display the data correctly in neuroglancer.

## Code

Code is simple, elegant and well structured. It contains useful code comments and docstrings. It is written in a way that is easy to understand and modify. It is also well documented.

A file IMPLEMENTATION.md is provided with a detailed description of the implementation and the code structure.