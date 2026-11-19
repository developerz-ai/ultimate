// The `/_x/db` wire has ONE spelling: the leaf both ends read. A path or the `--steps` rule
// restated in a client or a route is the drift this file refuses.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path API; `join` reaches each module from this directory.
import { join } from 'node:path';
import {
  DEV_LEDGER_PATH,
  DEV_MIGRATE_PATH,
  DEV_ROLLBACK_PATH,
  ROLLBACK_STEPS,
} from './db-dev-wire';
import { stepsOf } from './dev-db-rollback';

const DIR = import.meta.dir;
const LEAF = 'db-dev-wire.ts';

async function sources(): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for await (const file of new Bun.Glob('*.{ts,tsx}').scan({ cwd: DIR })) {
    if (file.includes('.test.') || file === LEAF) continue;
    found.set(file, await Bun.file(join(DIR, file)).text());
  }
  return found;
}

describe('unit · the /_x/db wire is stated once', () => {
  test('the leaf imports nothing, so a client reads it without the route’s graph', async () => {
    const text = await Bun.file(join(DIR, LEAF)).text();
    expect(new Bun.Transpiler({ loader: 'ts' }).scanImports(text)).toEqual([]);
    expect([DEV_MIGRATE_PATH, DEV_ROLLBACK_PATH, DEV_LEDGER_PATH]).toEqual([
      '/_x/db/migrate',
      '/_x/db/rollback',
      '/_x/db/ledger',
    ]);
  });

  test('no other module spells a /_x/db path or the --steps rule', async () => {
    const restated: string[] = [];
    for (const [file, text] of await sources()) {
      if (/['"`]\/_x\/db\/(?:migrate|rollback|ledger)/.test(text)) restated.push(`${file}: path`);
      if (/command:\s*'db rollback'/.test(text)) restated.push(`${file}: --steps rule`);
    }
    expect(restated).toEqual([]);
  });

  test('the door refuses the steps the flag refuses, by the one rule', () => {
    expect(ROLLBACK_STEPS.min).toBe(1);
    expect(stepsOf('2')).toBe(2);
    expect(() => stepsOf('0')).toThrow();
    expect(() => stepsOf(null)).toThrow();
  });
});
