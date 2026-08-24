/**
 * File System Access API surface that TypeScript's DOM lib does not ship yet.
 *
 * These are the Chromium-only pieces the portal depends on: permission
 * queries on stored handles, drag-and-drop handle extraction, and the
 * directory picker used as a keyboard-accessible alternative to dropping.
 */

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  /** Async iteration over children; not yet in TypeScript's DOM lib. */
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
  keys(): AsyncIterableIterator<string>;
}

interface DataTransferItem {
  /** Chromium-only; returns null for non-file items such as dragged text. */
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: FileSystemPermissionMode;
  startIn?: string | FileSystemHandle;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
