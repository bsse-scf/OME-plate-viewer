/**
 * A `FileSystemDirectoryHandle` implementation backed by node:fs.
 *
 * The portal's discovery and serving layers are written against the File
 * System Access API and nothing else, so a faithful adapter lets both be
 * tested against real directory trees without a browser.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

function notFound(name: string): DOMException {
  return new DOMException(`No entry named ${name}`, 'NotFoundError');
}

function typeMismatch(name: string): DOMException {
  return new DOMException(`Entry ${name} is the wrong type`, 'TypeMismatchError');
}

class NodeFileHandle {
  readonly kind = 'file' as const;

  constructor(
    readonly name: string,
    private readonly path: string,
  ) {}

  async getFile(): Promise<File> {
    const [data, stat] = await Promise.all([fs.readFile(this.path), fs.stat(this.path)]);
    return new File([data], this.name, { lastModified: stat.mtimeMs });
  }
}

class NodeDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor(
    readonly name: string,
    private readonly path: string,
  ) {}

  async getFileHandle(name: string): Promise<NodeFileHandle> {
    const target = join(this.path, name);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw notFound(name);
    }
    if (!stat.isFile()) throw typeMismatch(name);
    return new NodeFileHandle(name, target);
  }

  async getDirectoryHandle(name: string): Promise<NodeDirectoryHandle> {
    const target = join(this.path, name);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw notFound(name);
    }
    if (!stat.isDirectory()) throw typeMismatch(name);
    return new NodeDirectoryHandle(name, target);
  }

  async *values(): AsyncIterableIterator<NodeDirectoryHandle | NodeFileHandle> {
    const entries = await fs.readdir(this.path, { withFileTypes: true });
    for (const entry of entries) {
      const target = join(this.path, entry.name);
      yield entry.isDirectory()
        ? new NodeDirectoryHandle(entry.name, target)
        : new NodeFileHandle(entry.name, target);
    }
  }

  async *entries(): AsyncIterableIterator<[string, NodeDirectoryHandle | NodeFileHandle]> {
    for await (const handle of this.values()) yield [handle.name, handle];
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const handle of this.values()) yield handle.name;
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

export function directoryHandle(path: string, name?: string): FileSystemDirectoryHandle {
  return new NodeDirectoryHandle(
    name ?? path.slice(path.lastIndexOf('/') + 1),
    path,
  ) as unknown as FileSystemDirectoryHandle;
}
