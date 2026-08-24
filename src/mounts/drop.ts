/**
 * Turning a drag-and-drop into filesystem handles.
 */

export interface DropExtraction {
  directories: FileSystemDirectoryHandle[];
  /** Files dropped directly. A lone file is never a dataset folder. */
  files: FileSystemFileHandle[];
  /** Human-readable notes about items that were ignored. */
  problems: string[];
}

/**
 * Whether the browser can hand us real filesystem handles from a drop.
 *
 * The legacy `webkitGetAsEntry` path can also read dropped directories, but it
 * yields `FileSystemEntry` objects that cannot be structured-cloned into the
 * service worker, which is the whole basis of the virtual namespace. So this
 * is a hard requirement rather than a progressive enhancement.
 */
export function isDropSupported(): boolean {
  return (
    typeof DataTransferItem !== 'undefined' &&
    'getAsFileSystemHandle' in DataTransferItem.prototype
  );
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

/**
 * Extract handles from a drop event's `DataTransfer`.
 *
 * The `DataTransferItemList` is only valid for the duration of the event
 * dispatch, so every `getAsFileSystemHandle()` call is issued synchronously
 * before this function's first `await`. Callers must therefore invoke it
 * directly from the `drop` handler, not after awaiting something else.
 */
export async function extractHandles(dataTransfer: DataTransfer): Promise<DropExtraction> {
  const problems: string[] = [];
  const pending: Promise<FileSystemHandle | null>[] = [];

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') {
      problems.push(`Ignored a dragged ${item.kind || 'item'} (${item.type || 'unknown type'}).`);
      continue;
    }
    pending.push(item.getAsFileSystemHandle());
  }

  const directories: FileSystemDirectoryHandle[] = [];
  const files: FileSystemFileHandle[] = [];

  const settled = await Promise.allSettled(pending);
  for (const result of settled) {
    if (result.status === 'rejected') {
      problems.push(`Could not read a dropped item: ${String(result.reason)}`);
      continue;
    }
    const handle = result.value;
    if (!handle) continue;
    if (handle.kind === 'directory') {
      directories.push(handle as FileSystemDirectoryHandle);
    } else {
      files.push(handle as FileSystemFileHandle);
    }
  }

  return { directories, files, problems };
}
