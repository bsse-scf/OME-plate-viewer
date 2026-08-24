#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "PyQt6",
#   "xmltodict",
#   "tifffile",
#   "zarr>=3",
#   "numpy",
#   "xarray",
#   "multiview-stitcher @ git+https://github.com/multiview-stitcher/multiview-stitcher",
# ]
#
# [tool.uv]
# python-preference = "only-managed"
# ///
"""Open a Yokogawa CQ3000 dataset folder in Neuroglancer.

Drop a dataset folder onto the window (or use Browse…).  The script builds a
virtual OME-Zarr plate in memory and then shows a plate-map overview of all
available wells.  Click a well to open just that well in Neuroglancer, or use
"Show full fused plate" to open the whole plate at once.  Opening a new view
stops the previous server and starts a fresh one.

Run with:
    uv run yokogawa_neuroglancer.py
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
import xmltodict
import zarr
from zarr.abc.store import ByteRequest
from zarr.core.buffer import Buffer
from zarr.core.buffer.core import default_buffer_prototype
from zarr.storage import MemoryStore

from multiview_stitcher import msi_utils, param_utils
from multiview_stitcher import spatial_image_utils as si_utils
from multiview_stitcher import ngff_utils
from multiview_stitcher.vis_utils import generate_neuroglancer_json, get_neuroglancer_url

# ── dimension constants ────────────────────────────────────────────────────────

_DIMS = ["t", "c", "z", "y", "x"]
_SDIMS = ["z", "y", "x"]


# ── OME-XML helpers ────────────────────────────────────────────────────────────

def _as_list(value):
    return value if isinstance(value, list) else [value]


def _plane_index(plane, axis):
    return int(plane.get(f"@The{axis.upper()}", 0))


def _image_spacing(image):
    return {dim: float(image["Pixels"][f"@PhysicalSize{dim.upper()}"]) for dim in _SDIMS}


def _image_origin(image):
    planes = _as_list(image["Pixels"]["Plane"])
    return {
        dim: min(float(p[f"@Position{dim.upper()}"]) for p in planes)
        * (-1 if dim == "y" else 1)
        for dim in _SDIMS
    }


def _image_shape(image):
    return {dim: int(image["Pixels"][f"@Size{dim.upper()}"]) for dim in _DIMS}


def _image_filenames(image):
    planes = _as_list(image["Pixels"]["Plane"])
    tiff_datas = _as_list(image["Pixels"]["TiffData"])
    if len(planes) != len(tiff_datas):
        raise ValueError(
            f"{image['@Name']}: expected one TiffData per Plane, "
            f"got {len(tiff_datas)} TiffData for {len(planes)} planes"
        )
    return {
        (_plane_index(p, "t"), _plane_index(p, "c"), _plane_index(p, "z")): td["UUID"]["@FileName"]
        for p, td in zip(planes, tiff_datas)
    }


def _get_channel_info(ome_dict):
    def decode_color(color_int):
        c = int(color_int) & 0xFFFFFFFF
        r, g, b = (c >> 24) & 0xFF, (c >> 16) & 0xFF, (c >> 8) & 0xFF
        return {"hex": f"#{r:02X}{g:02X}{b:02X}"}

    images = ome_dict["OME"]["Image"]
    if not isinstance(images, list):
        images = [images]
    for image in images:
        ch = image.get("Pixels", {}).get("Channel")
        if isinstance(ch, list) and ch[0].get("@Name"):
            channels_raw = ch
            break
        elif isinstance(ch, dict) and ch.get("@Name"):
            channels_raw = [ch]
            break
    else:
        return []
    return [
        {"name": ch.get("@Name"), "color": decode_color(ch["@Color"]) if "@Color" in ch else None}
        for ch in channels_raw
    ]


def _channel_info_to_omero(channel_infos):
    channels = []
    for ch in channel_infos:
        color_hex = ch["color"]["hex"].lstrip("#") if ch["color"] else "FFFFFF"
        channels.append({
            "active": True, "coefficient": 1, "color": color_hex,
            "family": "linear", "inverted": False, "label": ch["name"],
            "window": {"start": 0, "end": 65535, "min": 0, "max": 65535},
        })
    return {"channels": channels}


# ── plane cache ────────────────────────────────────────────────────────────────

# Decoded TIFF planes are cached (LRU) so overlapping chunks, z-scrolling and
# re-renders reuse a decode instead of re-reading from (often networked) disk.
# The cap counts planes; memory use ≈ cap × plane_bytes (e.g. a 128-plane cap
# over 2000×2000 16-bit planes ≈ 1 GB).  Override with YOKOGAWA_PLANE_CACHE.
_PLANE_CACHE_SIZE = int(os.environ.get("YOKOGAWA_PLANE_CACHE", "128"))


@functools.lru_cache(maxsize=_PLANE_CACHE_SIZE)
def _read_plane(path: str) -> np.ndarray:
    """Read and squeeze one TIFF plane, caching the decoded array.

    The returned array is shared between callers and marked read-only, so
    callers must treat it as immutable — every call site here only reads from
    it or copies it out (``np.asarray`` / ``tobytes`` / ``astype``).
    """
    plane = np.squeeze(tifffile.imread(path))
    plane.setflags(write=False)
    return plane


def plane_cache_info():
    """Return LRU statistics (hits / misses / size) for the plane cache."""
    return _read_plane.cache_info()


# ── virtual Zarr stores ────────────────────────────────────────────────────────

class _TiffPlaneZarrStore(MemoryStore):
    """Read-only virtual Zarr-2 array backed by per-plane TIFF files.

    Shape: (t, c, z, y, x).  Chunks: (1, 1, 1, size_y, size_x).
    """

    supports_writes = False
    supports_deletes = False
    supports_listing = True

    def __init__(
        self,
        *,
        shape: tuple,
        dtype,
        filenames: dict,
        input_dir: Path,
        attrs: dict | None = None,
    ) -> None:
        super().__init__(read_only=True)
        self.shape = tuple(int(x) for x in shape)
        self.dtype = np.dtype(dtype)
        self.filenames = dict(filenames)
        self.input_dir = Path(input_dir)
        if len(self.shape) != 5:
            raise ValueError("shape must be (t, c, z, y, x)")
        if self.shape[0] != 1:
            raise ValueError("SizeT must be 1")
        self.chunks = (1, 1, 1, self.shape[3], self.shape[4])
        missing = (
            {(c, z) for c in range(self.shape[1]) for z in range(self.shape[2])}
            - set(self.filenames)
        )
        if missing:
            raise ValueError(f"Missing {len(missing)} TIFF planes; first examples: {sorted(missing)[:5]}")
        self._virtual_metadata = {
            ".zarray": json.dumps({
                "zarr_format": 2, "shape": list(self.shape), "chunks": list(self.chunks),
                "dtype": self.dtype.str, "compressor": None, "fill_value": 0,
                "order": "C", "filters": None, "dimension_separator": ".",
            }).encode(),
            ".zattrs": json.dumps({"_ARRAY_DIMENSIONS": _DIMS, **(attrs or {})}).encode(),
        }

    def with_read_only(self, read_only: bool = True):
        if not read_only:
            raise ValueError("read-only store")
        return self

    def _parse_chunk_key(self, key: str) -> tuple | None:
        try:
            loc = tuple(int(p) for p in key.split("."))
        except ValueError:
            return None
        if len(loc) != 5:
            return None
        counts = tuple((s + c - 1) // c for s, c in zip(self.shape, self.chunks))
        if any(i < 0 or i >= n for i, n in zip(loc, counts)):
            return None
        return loc

    async def get(self, key: str, prototype=None, byte_range: ByteRequest | None = None) -> Buffer | None:
        if prototype is None:
            prototype = default_buffer_prototype()
        if key in self._virtual_metadata:
            return prototype.buffer.from_bytes(self._virtual_metadata[key])
        loc = self._parse_chunk_key(key)
        if loc is None:
            return None
        t, c, z, y_chunk, x_chunk = loc
        if t != 0 or y_chunk != 0 or x_chunk != 0:
            return None
        filename = self.filenames.get((c, z))
        if filename is None:
            return None
        plane = await asyncio.to_thread(_read_plane, str(self.input_dir / filename))
        if plane.shape != self.shape[-2:]:
            raise ValueError(f"{filename}: TIFF shape {plane.shape} != expected {self.shape[-2:]}")
        data = np.asarray(plane, dtype=self.dtype, order="C").tobytes(order="C")
        return prototype.buffer.from_bytes(data)

    async def exists(self, key: str) -> bool:
        return key in self._virtual_metadata or self._parse_chunk_key(key) is not None

    async def list(self):
        for key in self._virtual_metadata:
            yield key

    async def list_prefix(self, prefix: str):
        async for key in self.list():
            if key.startswith(prefix):
                yield key

    async def list_dir(self, prefix: str):
        async for key in self.list():
            if key.startswith(prefix):
                yield key[len(prefix):]


class _WellZarrStore(_TiffPlaneZarrStore):
    """Read-only virtual Zarr array for a whole well arranged as a regular grid.

    Every FOV occupies exactly one chunk placed at ``grid_index * chunk_size``,
    where the chunk size equals the grid stride (FOV size minus the acquisition
    overlap).  A chunk request reads a single TIFF plane and keeps only its
    central chunk-sized region, so overlapping margins are trimmed and adjacent
    tiles abut — no stitching or blending.  FOVs smaller than the chunk (or
    empty grid cells at the border) leave zero-filled regions so every chunk
    keeps the same regular size.

    ``tiles`` must carry an ``offset`` whose y / x are exact multiples of the
    corresponding chunk size (see :func:`_build_well_zarr`).
    """

    def __init__(
        self,
        *,
        shape: tuple,
        dtype,
        tiles: list[dict],
        input_dir: Path,
        chunks: tuple,
        attrs: dict | None = None,
    ) -> None:
        MemoryStore.__init__(self, read_only=True)
        self.shape = tuple(int(x) for x in shape)
        self.dtype = np.dtype(dtype)
        self.tiles = list(tiles)
        self.input_dir = Path(input_dir)
        if len(self.shape) != 5:
            raise ValueError("shape must be (t, c, z, y, x)")
        self.chunks = tuple(int(x) for x in chunks)

        # Map each (y_chunk, x_chunk) grid cell to its single FOV.  Since a FOV
        # sits at offset = grid_index * chunk_size, the chunk index equals the
        # grid cell index.
        cy, cx = self.chunks[3], self.chunks[4]
        self._tile_at = {
            (t["offset"]["y"] // cy, t["offset"]["x"] // cx): t
            for t in self.tiles
        }

        self._virtual_metadata = {
            ".zarray": json.dumps({
                "zarr_format": 2, "shape": list(self.shape), "chunks": list(self.chunks),
                "dtype": self.dtype.str, "compressor": None, "fill_value": 0,
                "order": "C", "filters": None, "dimension_separator": ".",
            }).encode(),
            ".zattrs": json.dumps({"_ARRAY_DIMENSIONS": _DIMS, **(attrs or {})}).encode(),
        }

    async def get(self, key: str, prototype=None, byte_range: ByteRequest | None = None):
        if prototype is None:
            prototype = default_buffer_prototype()
        if key in self._virtual_metadata:
            return prototype.buffer.from_bytes(self._virtual_metadata[key])
        loc = self._parse_chunk_key(key)
        if loc is None:
            return None
        t, c, z_chunk, y_chunk, x_chunk = loc

        # One FOV per chunk: the grid cell selects a single tile / plane.
        tile = self._tile_at.get((y_chunk, x_chunk))
        if tile is None:
            return None  # empty grid cell -> zarr serves fill_value (0)
        ts = tile["shape"]
        if t >= ts["t"] or c >= ts["c"]:
            return None
        local_z = z_chunk - tile["offset"]["z"]
        if local_z < 0 or local_z >= ts["z"]:
            return None
        filename = tile["filenames"].get((t, c, local_z))
        if filename is None:
            return None

        plane = np.asarray(
            await asyncio.to_thread(_read_plane, str(self.input_dir / filename)),
            dtype=self.dtype,
        )
        # Trim the acquisition overlap: keep the central chunk-sized region of
        # the FOV (chunk size = grid stride = FOV minus overlap) so adjacent
        # tiles abut instead of duplicating their overlapping margins.
        cy, cx = self.chunks[3], self.chunks[4]
        py, px = plane.shape[-2:]
        oy, ox = max((py - cy) // 2, 0), max((px - cx) // 2, 0)
        cropped = plane[oy:oy + cy, ox:ox + cx]
        out = np.zeros((cy, cx), dtype=self.dtype)
        ch, cw = cropped.shape[-2:]
        out[:ch, :cw] = cropped  # remainder stays zero (border padding)
        return prototype.buffer.from_bytes(out.tobytes(order="C"))


# ── contrast detection ────────────────────────────────────────────────────────

def _auto_contrast(omero: dict, well_metadata: dict, input_dir: Path) -> dict:
    """Set per-channel window start/end in omero from a sample plane.

    Reads the central z-plane of the FOV whose centre is closest to the
    well centre, then uses the 1st/99th percentile of that plane as the
    contrast start/end for every msim.
    """
    store: _WellZarrStore = well_metadata["store"]
    tiles = store.tiles

    # FOV whose centre is closest to the well centre
    cy, cx = store.shape[3] / 2.0, store.shape[4] / 2.0
    central = min(
        tiles,
        key=lambda t: (
            (t["offset"]["y"] + t["shape"]["y"] / 2.0 - cy) ** 2
            + (t["offset"]["x"] + t["shape"]["x"] / 2.0 - cx) ** 2
        ),
    )
    z_mid = central["shape"]["z"] // 2
    n_channels = store.shape[1]  # (t, c, z, y, x)

    for c in range(n_channels):
        fname = central["filenames"].get((0, c, z_mid))
        if fname is None:
            continue
        try:
            plane = _read_plane(str(input_dir / fname)).astype(np.float32)
            lo = float(np.percentile(plane, 1))
            hi = float(np.percentile(plane, 99))
        except Exception:
            continue
        if c < len(omero["channels"]):
            omero["channels"][c]["window"]["start"] = lo
            omero["channels"][c]["window"]["end"] = hi

    return omero


# ── plate construction ─────────────────────────────────────────────────────────

def _grid_indices(offsets: list[int], cell_size: int) -> list[int]:
    """Cluster 1-D pixel offsets into 0-based regular grid-line indices.

    FOVs from a tiled acquisition lie on a regular grid but overlap, so their
    pixel offsets cluster around each grid line.  Sorting the offsets and
    starting a new line whenever the gap to the previous one exceeds half a cell
    yields one index per FOV.  Robust for overlaps below ~50 %.
    """
    order = sorted(range(len(offsets)), key=lambda i: offsets[i])
    indices = [0] * len(offsets)
    grid = 0
    prev = offsets[order[0]]
    for i in order:
        if offsets[i] - prev > cell_size / 2.0:
            grid += 1
        indices[i] = grid
        prev = offsets[i]
    return indices


def _grid_stride(offsets: list[int], grid_idx: list[int], fallback: int) -> int:
    """Average pixel step between adjacent grid lines (the non-overlap stride).

    Averages the offsets on each grid line, then divides the span by the number
    of gaps.  Returns *fallback* (the FOV size) when the axis has a single line,
    in which case there is no neighbouring tile and hence no overlap to trim.
    """
    n = max(grid_idx) + 1
    if n <= 1:
        return int(fallback)
    sums = [0.0] * n
    counts = [0] * n
    for off, g in zip(offsets, grid_idx):
        sums[g] += off
        counts[g] += 1
    lines = sorted(sums[g] / counts[g] for g in range(n))
    return int(round((lines[-1] - lines[0]) / (n - 1)))


def _build_well_zarr(
    well_index: int,
    well_image_dicts: dict,
    input_dir: Path,
    well_indices: list,
    well_rows: list,
    well_cols: list,
) -> tuple[zarr.Array, dict]:
    image_list = well_image_dicts[well_index]
    first_shape = _image_shape(image_list[0])
    dtype = image_list[0]["Pixels"]["@Type"]
    spacing = _image_spacing(image_list[0])

    tiles = []
    for iimage, image in enumerate(image_list):
        shape = _image_shape(image)
        if _image_spacing(image) != spacing:
            raise ValueError(f"{image['@Name']}: spacing differs from first FOV")
        if image["Pixels"]["@Type"] != dtype:
            raise ValueError(f"{image['@Name']}: dtype differs from first FOV")
        if any(shape[d] != first_shape[d] for d in ["t", "c"]):
            raise ValueError(f"{image['@Name']}: t/c shape differs from first FOV")
        filenames = _image_filenames(image)
        expected = {(t, c, z) for t in range(shape["t"]) for c in range(shape["c"]) for z in range(shape["z"])}
        missing = expected - set(filenames)
        if missing:
            raise ValueError(f"{image['@Name']}: missing {len(missing)} TIFF planes")
        tiles.append({"image_index": iimage, "shape": shape, "origin": _image_origin(image), "filenames": filenames})

    # Overlap-accurate pixel offset of each FOV; used only to infer the
    # acquisition grid, not for placement.
    well_origin = {dim: min(t["origin"][dim] for t in tiles) for dim in _SDIMS}
    px_offsets = {
        dim: [
            int(round((t["origin"][dim] - well_origin[dim]) / spacing[dim]))
            for t in tiles
        ]
        for dim in _SDIMS
    }

    # Infer the acquisition grid from the overlap-accurate offsets, then use the
    # grid *stride* (FOV minus overlap) as the chunk/cell size.  Each FOV is
    # center-cropped to that stride (in _WellZarrStore.get), trimming the
    # overlapping margins so neighbouring tiles abut — still one FOV per chunk,
    # no stitching.
    fov_y = max(t["shape"]["y"] for t in tiles)
    fov_x = max(t["shape"]["x"] for t in tiles)
    grid_rows = _grid_indices(px_offsets["y"], fov_y)
    grid_cols = _grid_indices(px_offsets["x"], fov_x)
    cell_y = _grid_stride(px_offsets["y"], grid_rows, fov_y)
    cell_x = _grid_stride(px_offsets["x"], grid_cols, fov_x)
    for i, tile in enumerate(tiles):
        tile["offset"] = {
            "z": px_offsets["z"][i],
            "y": grid_rows[i] * cell_y,
            "x": grid_cols[i] * cell_x,
        }

    n_rows, n_cols = max(grid_rows) + 1, max(grid_cols) + 1
    well_spatial_shape = {
        "z": max(t["offset"]["z"] + t["shape"]["z"] for t in tiles),
        "y": n_rows * cell_y,
        "x": n_cols * cell_x,
    }
    well_shape = tuple(
        first_shape[d] if d in ["t", "c"] else well_spatial_shape[d] for d in _DIMS
    )

    row = well_rows[well_indices.index(well_index)]
    col = well_cols[well_indices.index(well_index)]
    attrs = {
        "spacing": {dim: float(spacing[dim]) for dim in _SDIMS},
        "origin": {dim: float(well_origin[dim]) for dim in _SDIMS},
        "well_index": int(well_index), "row": row, "column": col,
        "n_fovs": len(tiles), "grid_shape": [int(n_rows), int(n_cols)],
    }

    store = _WellZarrStore(
        shape=well_shape, dtype=dtype, tiles=tiles, input_dir=input_dir,
        chunks=(1, 1, 1, int(cell_y), int(cell_x)), attrs=attrs,
    )
    array = zarr.open_array(store=store, mode="r", zarr_format=2)
    return array, {**attrs, "store": store}


def build_plate(input_dir: Path) -> tuple[dict[str, Any], dict]:
    """Return (plate_dict, omero) for a Yokogawa CQ3000 dataset directory."""
    ome_fns = list(input_dir.glob("*.ome.xml"))
    if not ome_fns:
        raise ValueError(f"No *.ome.xml file found in {input_dir}")
    ome_fn = min(ome_fns, key=lambda fn: len(fn.name))
    with open(ome_fn) as fh:
        ome_dict = xmltodict.parse(fh.read())

    omero = _channel_info_to_omero(_get_channel_info(ome_dict))

    well_dicts = [w for w in ome_dict["OME"]["Plate"]["Well"] if "WellSample" in w]
    well_indices = [int(w["@ID"].split(":")[1]) for w in well_dicts]
    well_rows = [chr(ord("A") + int(w["@Row"])) for w in well_dicts]
    well_cols = [str(w["@Column"]) for w in well_dicts]

    well_image_dicts: dict[int, list] = {}
    for image in ome_dict["OME"]["Image"]:
        if image["@Name"] == "TitleImage":
            continue
        idx = int(image["@Name"].split("(")[0][1:]) - 1
        well_image_dicts.setdefault(idx, []).append(image)

    unique_rows = sorted(set(well_rows))
    unique_cols = sorted(set(well_cols))

    plate_dict: dict[str, Any] = {}
    first_well_metadata: dict | None = None

    for iwell, well_index in enumerate(well_indices):
        array, metadata = _build_well_zarr(
            well_index, well_image_dicts, input_dir, well_indices, well_rows, well_cols
        )
        if first_well_metadata is None:
            first_well_metadata = metadata

        sim = si_utils.get_sim_from_array(
            array, dims=_DIMS,
            scale=metadata["spacing"], translation=metadata["origin"],
        )
        msim = msi_utils.get_msim_from_sim(sim, scale_factors=[])
        extent = si_utils.get_extent_from_sim(sim)
        row, col = well_rows[iwell], well_cols[iwell]
        irow, icol = unique_rows.index(row), unique_cols.index(col)
        xaffine = param_utils.affine_to_xaffine(
            param_utils.affine_from_translation(
                [extent["z"], extent["y"] * irow, extent["x"] * icol]
            )
        )
        msi_utils.set_affine_transform(msim, xaffine, transform_key="plate")
        msim.attrs["omero"] = omero
        plate_dict[f"{row}/{col}/0"] = msim

    # Auto-detect per-channel contrast from the central FOV of the first well
    if first_well_metadata is not None:
        omero = _auto_contrast(omero, first_well_metadata, input_dir)
        for msim in plate_dict.values():
            msim.attrs["omero"] = omero

    return plate_dict, omero


def start_neuroglancer(
    msims, port: int, single_layer: bool = True
) -> tuple[Any, str]:
    """Start a virtual server for *msims* and return (server, neuroglancer_url).

    *msims* is an iterable of msims (or sims) — pass a single well's msim to
    view that well, or every well's msim to view the whole fused plate.
    """
    msims = [
        img if msi_utils.is_msim(img) else msi_utils.get_msim_from_sim(img, scale_factors=[])
        for img in msims
    ]
    server = ngff_utils.serve_virtual_ome_zarrs(
        msims, port=port, max_concurrent_chunks=16,)
    server.start()
    resolved_sims = [msi_utils.get_sim_from_msim(m) for m in msims]
    ng_json = generate_neuroglancer_json(
        ome_zarr_paths=None,
        ome_zarr_urls=[url.rstrip("/") for url in server.urls],
        sims=resolved_sims,
        transform_key="plate",
        single_layer=single_layer,
        layout='xy',
    )
    return server, get_neuroglancer_url(ng_json)


# ── GUI ────────────────────────────────────────────────────────────────────────

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QApplication, QFileDialog, QFrame, QGridLayout, QHBoxLayout, QLabel,
    QLineEdit, QMainWindow, QPushButton, QScrollArea, QVBoxLayout, QWidget,
)


class _BuildWorker(QThread):
    """Builds the plate on a background thread (no server, no browser)."""

    plate_ready = pyqtSignal(object)  # emits the plate_dict
    failed      = pyqtSignal(str)

    def __init__(self, input_dir: Path) -> None:
        super().__init__()
        self.input_dir = input_dir

    def run(self) -> None:
        try:
            plate_dict, _ = build_plate(self.input_dir)
        except Exception as exc:
            self.failed.emit(str(exc))
            return
        self.plate_ready.emit(plate_dict)


def _sort_col_key(col: str):
    """Sort well columns numerically when possible, else lexicographically."""
    return (0, int(col)) if col.isdigit() else (1, col)


_WELL_STYLE = """
QPushButton {
    border: 2px solid #0071e3;
    border-radius: 24px;
    background: #dbeafe;
    color: #0b3a6f;
    font-weight: bold;
}
QPushButton:hover  { background: #93c5fd; }
QPushButton:pressed{ background: #60a5fa; }
"""


class _PlateOverview(QWidget):
    """A microplate-style grid of clickable wells.

    Lays the wells out like a physical plate (row letters down the left,
    column numbers across the top).  Positions that contain data become
    clickable circular buttons; empty positions are left blank.  Clicking a
    well emits ``well_clicked`` with that well's ``"row/col/fov"`` key.
    """

    well_clicked = pyqtSignal(str)

    def __init__(self, plate_dict: dict) -> None:
        super().__init__()

        # plate_dict keys look like "B/2/0" -> (row, col) -> full key
        wells: dict[tuple[str, str], str] = {}
        for key in plate_dict:
            row, col, _fov = key.split("/")
            wells[(row, col)] = key
        rows = sorted({r for r, _ in wells})
        cols = sorted({c for _, c in wells}, key=_sort_col_key)

        grid = QGridLayout(self)
        grid.setSpacing(4)

        # column headers
        for j, col in enumerate(cols):
            lbl = QLabel(col)
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl.setStyleSheet("color:#666; font-weight:bold;")
            grid.addWidget(lbl, 0, j + 1)

        # row headers + well buttons
        for i, row in enumerate(rows):
            rlbl = QLabel(row)
            rlbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            rlbl.setStyleSheet("color:#666; font-weight:bold;")
            grid.addWidget(rlbl, i + 1, 0)
            for j, col in enumerate(cols):
                key = wells.get((row, col))
                if key is None:
                    continue  # empty plate position
                btn = QPushButton(f"{row}{col}")
                btn.setFixedSize(48, 48)
                btn.setCursor(Qt.CursorShape.PointingHandCursor)
                btn.setStyleSheet(_WELL_STYLE)
                btn.setToolTip(f"Open well {row}{col} in Neuroglancer")
                btn.clicked.connect(
                    lambda _checked=False, k=key: self.well_clicked.emit(k)
                )
                grid.addWidget(btn, i + 1, j + 1)


class _DropZone(QFrame):
    """A styled frame that accepts folder drops and emits folder_dropped(path)."""

    folder_dropped = pyqtSignal(str)

    _IDLE   = "QFrame{border:2px dashed #aaa;border-radius:10px;background:#fafafa}"
    _HOVER  = "QFrame{border:2px dashed #0071e3;border-radius:10px;background:#dbeafe}"

    def __init__(self) -> None:
        super().__init__()
        self.setAcceptDrops(True)
        self.setMinimumHeight(90)
        self.setStyleSheet(self._IDLE)
        self._lbl = QLabel("Drop dataset folder here")
        self._lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lay = QVBoxLayout(self)
        lay.addWidget(self._lbl)

    def set_text(self, text: str) -> None:
        self._lbl.setText(text)

    def dragEnterEvent(self, e) -> None:
        if e.mimeData().hasUrls():
            e.acceptProposedAction()
            self.setStyleSheet(self._HOVER)

    def dragLeaveEvent(self, _) -> None:
        self.setStyleSheet(self._IDLE)

    def dropEvent(self, e) -> None:
        self.setStyleSheet(self._IDLE)
        for url in e.mimeData().urls():
            path = url.toLocalFile()
            if Path(path).is_dir():
                self.folder_dropped.emit(path)
                return


class _App(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Yokogawa → Neuroglancer")
        self.setMinimumWidth(400)
        self._worker: _BuildWorker | None = None
        self._server = None
        self._plate_dict: dict | None = None
        self._current_name = ""

        w = QWidget()
        self.setCentralWidget(w)
        vbox = QVBoxLayout(w)
        vbox.setContentsMargins(16, 16, 16, 16)
        vbox.setSpacing(8)

        self._zone = _DropZone()
        self._zone.folder_dropped.connect(self._load)
        vbox.addWidget(self._zone)

        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse)
        vbox.addWidget(browse)

        hbox = QHBoxLayout()
        hbox.addWidget(QLabel("Port:"))
        self._port = QLineEdit("8060")
        self._port.setFixedWidth(70)
        hbox.addWidget(self._port)
        hbox.addStretch()
        vbox.addLayout(hbox)

        self._status = QLabel("Ready — drop a dataset folder above.")
        self._status.setWordWrap(True)
        vbox.addWidget(self._status)

        # ── well overview (hidden until a plate is built) ───────────────────
        self._overview_container = QWidget()
        ov = QVBoxLayout(self._overview_container)
        ov.setContentsMargins(0, 0, 0, 0)
        ov.setSpacing(8)

        ov_label = QLabel("Wells — click one to open it in Neuroglancer:")
        ov_label.setStyleSheet("font-weight:bold;")
        ov.addWidget(ov_label)

        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setMinimumHeight(140)
        self._scroll.setMaximumHeight(320)
        ov.addWidget(self._scroll)

        self._full_plate_btn = QPushButton("Show full fused plate")
        self._full_plate_btn.clicked.connect(self._open_full_plate)
        ov.addWidget(self._full_plate_btn)

        self._overview_container.setVisible(False)
        vbox.addWidget(self._overview_container)

        tips = QLabel(
            "<b>Neuroglancer tips</b><br>"
            "Pan · drag with mouse<br>"
            "Zoom · Ctrl + scroll wheel<br>"
            "Z slice · scroll wheel"
        )
        tips.setStyleSheet("color: #666; font-size: 11px;")
        tips.setTextFormat(Qt.TextFormat.RichText)
        vbox.addWidget(tips)

    def _browse(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "Select Yokogawa dataset folder")
        if path:
            self._load(path)

    def _load(self, path: str) -> None:
        if self._worker and self._worker.isRunning():
            self._status.setText("Still loading — please wait.")
            return

        self._current_name = Path(path).name
        self._worker = _BuildWorker(Path(path))
        self._worker.plate_ready.connect(self._on_plate_ready)
        self._worker.failed.connect(self._on_build_failed)
        self._zone.set_text(f"⏳  {self._current_name}")
        self._status.setText(f"Building plate from {self._current_name}…")
        self._overview_container.setVisible(False)
        self._worker.start()

    def _on_plate_ready(self, plate_dict: dict) -> None:
        self._plate_dict = plate_dict
        n = len(plate_dict)
        self._zone.set_text(
            f"✓  {self._current_name}  ({n} well{'s' if n != 1 else ''})"
        )
        self._status.setText(
            f"Built {n} well{'s' if n != 1 else ''}. "
            "Click a well below, or show the full fused plate."
        )
        overview = _PlateOverview(plate_dict)
        overview.well_clicked.connect(self._open_well)
        self._scroll.setWidget(overview)  # replaces & deletes any previous grid
        self._overview_container.setVisible(True)

    def _on_build_failed(self, msg: str) -> None:
        self._zone.set_text("Drop dataset folder here")
        self._status.setText(f"Error: {msg}")

    def _open_msims(self, msims, single_layer: bool, status_msg: str) -> None:
        """Stop the running server (if any), serve *msims*, and open the browser."""
        try:
            port = int(self._port.text() or "8060")
        except ValueError:
            self._status.setText("Invalid port.")
            return

        if self._server is not None:
            try:
                self._server.stop()
            except Exception:
                pass
            self._server = None

        try:
            self._server, ng_url = start_neuroglancer(
                msims, port, single_layer=single_layer
            )
        except Exception as exc:
            self._status.setText(f"Server error: {exc}")
            return

        webbrowser.open(ng_url)
        self._status.setText(status_msg)

    def _open_well(self, key: str) -> None:
        if not self._plate_dict:
            return
        row, col, _fov = key.split("/")
        self._open_msims(
            [self._plate_dict[key]],
            single_layer=True,
            status_msg=f"Serving well {row}{col} on port "
            f"{self._port.text() or '8060'}. Neuroglancer opened.",
        )

    def _open_full_plate(self) -> None:
        if not self._plate_dict:
            return
        n = len(self._plate_dict)
        self._open_msims(
            list(self._plate_dict.values()),
            single_layer=True,
            status_msg=f"Serving full plate ({n} well{'s' if n != 1 else ''}) "
            f"on port {self._port.text() or '8060'}. Neuroglancer opened.",
        )


# ── entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    app = QApplication(sys.argv)
    window = _App()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
