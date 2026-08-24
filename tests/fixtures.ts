/**
 * Writing a synthetic acquisition to a temporary directory, for the Node tests.
 *
 * The acquisition itself is built by `synthetic.ts`, which the browser run
 * shares; this only lays the files down.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildFixture, FIXTURE_METADATA, type FixtureOptions } from './synthetic';

export { DEFAULT_FIXTURE, encodeTiff, pixelValue, type FixtureOptions } from './synthetic';

/** Write a complete synthetic dataset folder and return its OME-XML file name. */
export async function writeFixture(root: string, options?: FixtureOptions): Promise<string> {
  for (const file of buildFixture(options)) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  return FIXTURE_METADATA;
}
