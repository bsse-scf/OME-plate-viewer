/**
 * Virtual HTTP serving, independent of the Service Worker that hosts it.
 *
 * This module turns a URL into a Response: path parsing, ranges, status codes,
 * content types, and the composition of "which chunk is this?" (`yokogawa/zarr`)
 * with "read it" (`yokogawa/tiff`, `yokogawa/chunk`). Keeping it free of
 * IndexedDB and worker lifecycle — which live in `sw.ts` — is what lets the
 * whole serving path be tested in Node against a real dataset on disk.
 *
 * Reading the files themselves is in `files.ts`, which the page shares.
 */
import { materialiseChunk, parseDtype, passthroughRange, workingSetBytes } from '../yokogawa/chunk';
import type { PlaneLayout } from '../yokogawa/tiff';
import { findWell, resolve, type Resolution } from '../yokogawa/zarr';
import { AbortError } from './gate';
import { isNotAllowed } from './files';
import { SW_VERSION, type DatasetRecord } from './protocol';

export interface ParsedPath {
  /** First segment after the namespace prefix: the dataset id. */
  id: string;
  /** Remaining decoded segments; empty when the URL targets the root. */
  segments: string[];
  /** True when the URL ended in `/`, i.e. it names a directory. */
  trailingSlash: boolean;
}

/**
 * Split `<prefix><id>/a/b/c` into its parts, rejecting anything that could
 * escape the dataset root. Returns null for a malformed path.
 */
export function parsePath(pathname: string, prefix: string): ParsedPath | null {
  if (!pathname.startsWith(prefix)) return null;

  const rest = pathname.slice(prefix.length);
  if (rest === '') return null;

  const trailingSlash = rest.endsWith('/');
  const rawParts = rest.split('/').filter((part) => part !== '');
  if (rawParts.length === 0) return null;

  const decoded: string[] = [];
  for (const part of rawParts) {
    let value: string;
    try {
      value = decodeURIComponent(part);
    } catch {
      return null;
    }
    // `.` and `..` never appear in a legitimate Zarr key, and honouring them
    // would let a crafted URL read outside the dataset folder.
    if (value === '.' || value === '..' || value.includes('/') || value.includes('\0')) {
      return null;
    }
    decoded.push(value);
  }

  const [id, ...segments] = decoded;
  return { id, segments, trailingSlash };
}

/* ------------------------------------------------------------- responses */

export function baseHeaders(extra?: Record<string, string>): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    // The bytes derive from live files the user may overwrite, and a cache
    // entry would outlive the dataset it belongs to.
    'Cache-Control': 'no-store',
    'X-Local-Server': `cq3000-viewer/${SW_VERSION}`,
    ...extra,
  });
}

export function errorResponse(
  status: number,
  message: string,
  extra?: Record<string, string>,
): Response {
  return new Response(message, {
    status,
    headers: baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...extra }),
  });
}

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=...` header against a known size.
 *
 * Returns `null` when the header is absent or asks for something we choose to
 * answer with a full body — multiple ranges or an unknown unit. RFC 9110 lets
 * a server ignore `Range` entirely, so a 200 is always a valid answer.
 * `'unsatisfiable'` means the range lies outside the resource and the caller
 * must answer 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): ParsedRange | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1].trim();
  if (spec.includes(',')) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;

  const [, rawStart, rawEnd] = parts;

  if (rawStart === '') {
    if (rawEnd === '') return null;
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: Math.max(0, size - 1) };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * Build a response for a blob, honouring `Range` and `HEAD`.
 *
 * `Content-Length` is always set explicitly: a HEAD response has no body to
 * infer it from, and Neuroglancer's HTTP key-value store reads it.
 */
export function serveBlob(
  request: Request,
  blob: Blob,
  contentType: string,
  extra?: Record<string, string>,
): Response {
  const size = blob.size;
  const range = parseRange(request.headers.get('Range'), size);

  if (range === 'unsatisfiable') {
    return errorResponse(416, 'Range Not Satisfiable', {
      'Content-Range': `bytes */${size}`,
      ...extra,
    });
  }

  const isHead = request.method === 'HEAD';

  if (range) {
    const length = range.end - range.start + 1;
    return new Response(isHead ? null : blob.slice(range.start, range.end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: baseHeaders({
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        ...extra,
      }),
    });
  }

  return new Response(isHead ? null : blob, {
    status: 200,
    headers: baseHeaders({ 'Content-Type': contentType, 'Content-Length': String(size), ...extra }),
  });
}

/* ------------------------------------------------------------- the handler */

export interface ZarrServeOptions {
  prefix: string;
  lookupDataset: (datasetId: string) => Promise<DatasetRecord | null>;
  /** Open a dataset-relative file, with whatever caching the host provides. */
  openFile: (dataset: DatasetRecord, path: string) => Promise<File | null>;
  /** Read a plane's TIFF directory, with whatever caching the host provides. */
  planeLayout: (dataset: DatasetRecord, path: string, file: File) => Promise<PlaneLayout>;
  /**
   * Bound the work in flight, so a viewport full of chunks cannot swamp memory.
   *
   * `cost` is the working set the task will hold; `signal` lets the host drop
   * the task if the viewer stops wanting it before it starts.
   */
  gate?: <T>(cost: number, task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

/**
 * Serve a request under the `_zarr/` namespace.
 *
 * `GET|HEAD <base>_zarr/<dataset-id>/<well>/<level>/<t>.<c>.<z>.<y>.<x>`
 */
export async function serveZarr(
  request: Request,
  url: URL,
  options: ZarrServeOptions,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const parsed = parsePath(url.pathname, options.prefix);
  if (!parsed) return errorResponse(400, 'Bad virtual path');

  const dataset = await options.lookupDataset(parsed.id);
  if (!dataset) {
    return errorResponse(404, `No dataset "${parsed.id}". Drop the folder on the page again.`, {
      'X-Local-Error': 'unknown-dataset',
    });
  }

  const [wellId, ...rest] = parsed.segments;
  const well = wellId ? findWell(dataset.model, wellId) : undefined;
  if (!well) {
    return errorResponse(404, 'Not Found', { 'X-Local-Error': 'unknown-well' });
  }

  let resolution: Resolution;
  try {
    resolution = resolve(dataset.model, well, rest);
  } catch (error) {
    return errorResponse(500, `Could not resolve this key: ${String(error)}`);
  }

  if (resolution.kind === 'missing') {
    return errorResponse(404, 'Not Found', { 'X-Local-Error': 'not-found' });
  }
  if (resolution.kind === 'empty') {
    // A gap in the acquisition grid. Zarr reads a missing chunk as the array's
    // fill value, so an honest 404 shows blank rather than an error.
    return errorResponse(404, 'Not Found', { 'X-Local-Error': 'empty-chunk' });
  }
  if (resolution.kind === 'json') {
    return serveBlob(request, new Blob([resolution.body]), 'application/json');
  }

  // Neuroglancer drops the chunks it no longer needs the moment the view
  // moves. Chrome does not pass that on through `FetchEvent.request.signal` —
  // it is never aborted — but it does cancel the *response stream*, so that is
  // what the work is hung from. Everything expensive happens inside the stream,
  // and a cancel unhooks it: a chunk still queued is dropped before it reads
  // anything, and the requests that replaced it get the bandwidth instead.
  const run = options.gate ?? (<T,>(_cost: number, task: () => Promise<T>) => task());
  const chunk = resolution;
  const record = dataset;

  let file: File | null;
  try {
    // Cheap: a directory lookup, no pixels. Done before the response so that a
    // plane the acquisition never wrote is still an honest 404, which Zarr
    // reads as the array's fill value.
    file = await options.openFile(record, chunk.file);
  } catch (error) {
    if (isNotAllowed(error)) {
      return errorResponse(
        403,
        'Read permission for this folder was not granted. Drop the folder on the page again.',
        { 'X-Local-Error': 'permission-lost' },
      );
    }
    return errorResponse(500, `Error reading ${chunk.file}: ${String(error)}`);
  }
  if (!file) {
    return errorResponse(404, `Missing plane ${chunk.file}`, { 'X-Local-Error': 'missing-plane' });
  }

  const source = file;
  const cost = workingSetBytes(chunk.geometry, record.model.bytesPerSample);

  /**
   * Read the chunk's bytes: the whole expensive half, behind the gate.
   *
   * The TIFF directory is read here rather than before the response, even
   * though it is only two small reads. A request that has not yet produced a
   * response has nothing to cancel, so anything done ahead of the stream is
   * work the viewer cannot call off — and with a viewport's worth of requests
   * arriving at once, those small reads are enough to matter.
   */
  const read = async (): Promise<Uint8Array> => {
    const layout = await options.planeLayout(record, chunk.file, source);

    // The whole point of the format: when the chunk is exactly the plane and
    // the plane is uncompressed, its bytes are a range of the file.
    const direct = passthroughRange(layout, chunk.geometry, chunk.dtype);
    if (direct) {
      return new Uint8Array(await source.slice(direct.start, direct.end).arrayBuffer());
    }
    return materialiseChunk(source, layout, chunk.geometry, chunk.dtype);
  };

  // A chunk's size follows from its geometry, so the length can be declared
  // before a single pixel is read — which is what lets the response go out
  // first and the reading hang off it.
  const length = chunk.geometry.outY * chunk.geometry.outX * parseDtype(chunk.dtype).bytes;

  // HEAD and byte ranges are answered from a finished buffer: neither is on the
  // viewer's path, and both need the whole chunk anyway.
  if (request.method === 'HEAD' || request.headers.get('Range')) {
    try {
      return serveBlob(request, new Blob([await run(cost, read)]), 'application/octet-stream');
    } catch (error) {
      return errorResponse(500, `Could not read ${chunk.file}: ${String(error)}`);
    }
  }

  const cancelled = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const bytes = await run(cost, read, cancelled.signal);
        // The viewer may have moved on while this was being built, in which
        // case the stream is already gone and there is nothing to hand it.
        if (cancelled.signal.aborted) return;
        controller.enqueue(bytes);
        controller.close();
      } catch (error) {
        // A cancelled chunk is the normal case, not a fault.
        if (cancelled.signal.aborted || error instanceof AbortError) return;
        console.warn(`cq3000: could not read ${chunk.file}`, error);
        controller.error(error);
      }
    },
    cancel() {
      cancelled.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: baseHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
    }),
  });
}
