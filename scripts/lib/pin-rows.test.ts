// `importPinSource` re-anchors a pins module's relative imports to the file they came from. The
// anchor must be a filesystem path: a `URL.pathname` percent-encodes a space, so a checkout under
// `My Projects` resolved to a directory that does not exist and every table's comparison crashed.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive delete, no tmpdir() and no path-join primitive — the
// fixture needs a real directory whose path holds a space.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPinSource, pinRows } from './pin-rows';

describe('importPinSource', () => {
  test('a relative import from a checkout whose path holds a space still loads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pin rows '));
    try {
      const lib = join(home, 'My Projects', 'scripts', 'lib');
      await Bun.write(join(lib, 'base-ref.ts'), "export const BASE_REF = 'spaced';\n");
      const source = [
        "import { BASE_REF } from './base-ref';",
        'export const DEMO_PINS = { [BASE_REF]: 3 };',
      ].join('\n');
      const loaded = await importPinSource(
        source,
        join(home, 'scratch'),
        join(lib, 'demo-pins.ts'),
      );
      expect([...pinRows(loaded)]).toEqual([['DEMO_PINS.spaced', 3]]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
