/**
 * Reading files out of a mounted dataset folder.
 *
 * Split out from `serve.ts` because the page needs it too: sampling a plane for
 * auto-contrast opens a file the same way the worker does, and neither should
 * have to know about the other.
 */

export function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export function isTypeMismatch(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TypeMismatchError';
}

export function isNotAllowed(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

/**
 * Open a dataset-relative file, e.g. `Image/W0001F0001T0001Z001C1.tif`.
 *
 * `resolveDirectory` is injected so the worker can cache intermediate handles:
 * every plane of a 30 000-file acquisition shares the same `Image/` prefix,
 * and re-walking it per request is the difference between smooth and unusable.
 */
export async function openDatasetFile(
  root: FileSystemDirectoryHandle,
  path: string,
  resolveDirectory: (
    root: FileSystemDirectoryHandle,
    segments: string[],
  ) => Promise<FileSystemDirectoryHandle | null> = defaultResolveDirectory,
): Promise<File | null> {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;

  const parent = await resolveDirectory(root, segments.slice(0, -1));
  if (parent === null) return null;

  try {
    return await (await parent.getFileHandle(segments[segments.length - 1])).getFile();
  } catch (error) {
    if (isNotFound(error) || isTypeMismatch(error)) return null;
    throw error;
  }
}

export async function defaultResolveDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle | null> {
  let handle = root;
  for (const segment of segments) {
    try {
      handle = await handle.getDirectoryHandle(segment);
    } catch (error) {
      if (isNotFound(error) || isTypeMismatch(error)) return null;
      throw error;
    }
  }
  return handle;
}
