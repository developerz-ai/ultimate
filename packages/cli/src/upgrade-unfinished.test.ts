// The record of a hop between its pin write and its gate: written whole, read back total (a torn or
// hand-edited file is no record), cleared once the gate returns.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  clearUnfinished,
  parseUnfinished,
  readUnfinished,
  UNFINISHED_FILE,
  writeUnfinished,
} from './upgrade-unfinished';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RECORD = {
  from: '19.4.0',
  to: '20.1.0',
  bunFrom: '>=1.3.0',
  bunTo: '>=1.4.4',
  startedAt: '2026-11-15T00:00:00.000Z',
};

describe('unit · x upgrade, the unfinished hop', () => {
  test('written, read back and cleared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-unfinished-'));
    dirs.push(dir);
    expect(await readUnfinished(dir)).toBeUndefined();
    await writeUnfinished(dir, RECORD);
    expect(await readUnfinished(dir)).toEqual(RECORD);
    await clearUnfinished(dir);
    expect(await Bun.file(join(dir, UNFINISHED_FILE)).exists()).toBe(false);
    await clearUnfinished(dir);
  });

  test('a torn or foreign file is no record', () => {
    expect(parseUnfinished('{"from":"19.4.0"')).toBeUndefined();
    expect(parseUnfinished('{"from":"19.4.0","to":3}')).toBeUndefined();
    expect(parseUnfinished(JSON.stringify({ ...RECORD, bunTo: 3 }))).toBeUndefined();
    expect(parseUnfinished(JSON.stringify({ ...RECORD, bunFrom: null }))).toEqual({
      ...RECORD,
      bunFrom: null,
    });
  });
});
