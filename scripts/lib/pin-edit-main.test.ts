// `--write-pin`'s file half on a scratch root: the named over row is drafted, an unnamed or
// under-pin row is not, and a per-site table answers to the file its keys open with.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
import { PIN_WHY_PLACEHOLDER } from './pin-edit';
import type { PinEditSpec } from './pin-edit-main';
import { writePins } from './pin-edit-main';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const FILE = 'scripts/lib/probe-pins.ts';
const TABLE = `export const PROBE_PINS: Readonly<Record<string, number>> = {
  cli: 1,
  core: 2,
};
`;

interface Site {
  readonly path: string;
}

const spec = (sites: readonly Site[], groupOf?: (site: Site) => string): PinEditSpec<Site> => ({
  script: 'probe',
  pinsFile: FILE,
  pins: { cli: 1, core: 2 },
  sites: async () => sites,
  findingFor: () => ({ code: 'X_PROBE', cause: 'probe', fix: 'bun run scripts/probe.ts' }),
  clean: 'clean',
  target: {
    script: 'scripts/probe.ts',
    file: FILE,
    table: 'PROBE_PINS',
    nameOf: (key) => key.split(': ')[0] ?? key,
  },
  ...(groupOf === undefined ? {} : { groupOf }),
});

async function root(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/pin-edit-main-`);
  made.push(dir);
  await Bun.write(`${dir}/${FILE}`, TABLE);
  return dir;
}

const at = (pkg: string, count: number): Site[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `packages/${pkg}/src/f${String(index)}.ts`,
  }));

describe('writePins', () => {
  test('drafts the named over row and leaves every other row as it was', async () => {
    const dir = await root();
    const raises = await writePins(dir, spec([...at('cli', 3), ...at('core', 3)]), ['cli']);
    expect(raises.map((raise) => [raise.key, raise.from, raise.to])).toEqual([['cli', 1, 3]]);
    const text = await Bun.file(`${dir}/${FILE}`).text();
    expect(text).toContain(`  ${PIN_WHY_PLACEHOLDER}\n  cli: 3,\n  core: 2,\n`);
  });

  test('a row at or under its pin drafts nothing and writes nothing', async () => {
    const dir = await root();
    expect(await writePins(dir, spec(at('core', 1)), ['core', 'cli'])).toEqual([]);
    expect(await Bun.file(`${dir}/${FILE}`).text()).toBe(TABLE);
  });

  test('a per-site table answers to the file its keys open with', async () => {
    const dir = await root();
    const sites = [{ path: 'scripts/a.ts' }, { path: 'scripts/a.ts' }];
    const raises = await writePins(
      dir,
      spec(sites, (site) => `${site.path}: x === y`),
      ['scripts/a.ts'],
    );
    expect(raises.map((raise) => raise.name)).toEqual(['scripts/a.ts']);
    expect(await Bun.file(`${dir}/${FILE}`).text()).toContain("'scripts/a.ts: x === y': 2,");
  });
});
