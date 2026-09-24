import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent — `mkdtemp`/`rm` own each fixture pins file's directory.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { applyUnpin, packageOf, pinnedFor, ratchetGaps, siteCounts } from './ratchet';

const FILE = 'pins.ts';
const site = (path: string) => ({ path, line: 1 });

async function withPins(text: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-ratchet-'));
  try {
    await Bun.write(join(dir, FILE), text);
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('unit · the per-package ratchet', () => {
  test('over, stale and clean, sorted by package, with the first site of an over', () => {
    const sites = [
      site('packages/ui/src/a.ts'),
      site('packages/ui/src/b.ts'),
      site('scripts/c.ts'),
    ];
    const gaps = ratchetGaps(sites, { ui: 1, scripts: 1, core: 2 }, true);
    expect(gaps.map((gap) => [gap.kind, gap.pkg, gap.found, gap.pinned])).toEqual([
      ['stale', 'core', 0, 2],
      ['over', 'ui', 2, 1],
    ]);
    expect(gaps[1]?.first).toEqual(site('packages/ui/src/a.ts'));
  });

  test('a corpus that read nothing is UNSCANNED, never a clean tree', () => {
    expect(ratchetGaps([], {}, false).map((gap) => gap.kind)).toEqual(['unscanned']);
  });

  test('a blank reason is reported AND its count is not honoured', () => {
    const pins = { ui: { count: 3, reason: '  ' } };
    expect(pinnedFor('ui', pins)).toBe(0);
    const kinds = ratchetGaps([site('packages/ui/src/a.ts')], pins, true).map((gap) => gap.kind);
    expect(kinds).toEqual(['unexplained', 'over']);
    expect(pinnedFor('ui', { ui: { count: 3, reason: 'a sentence' } })).toBe(3);
  });

  test('a prototype member is never a pin', () => {
    expect(pinnedFor('constructor', {})).toBe(0);
    expect(pinnedFor('toString', { ui: 1 })).toBe(0);
  });

  test('packageOf and siteCounts group by package, and by top directory outside packages/', () => {
    expect(packageOf('packages/cli/src/x.ts')).toBe('cli');
    expect(packageOf('scripts/lib/x.ts')).toBe('scripts');
    expect(siteCounts([site('packages/ui/src/a.ts'), site('packages/ui/src/b.ts')])).toEqual({
      ui: 2,
    });
  });
});

describe('unit · --unpin edits the pins file', () => {
  test('lowers a flat row, deletes one at zero, and refuses to raise one', async () => {
    const pins = { realtime: 3, ui: 2 };
    await withPins('export const P = {\n  realtime: 3,\n  ui: 2,\n};\n', async (dir) => {
      expect(await applyUnpin(dir, FILE, ['realtime'], { realtime: 3 }, pins)).toEqual([]);
      expect(await applyUnpin(dir, FILE, ['realtime'], { realtime: 1 }, pins)).toEqual([
        'realtime -> 1',
      ]);
      expect(await applyUnpin(dir, FILE, ['ui'], {}, pins)).toEqual(['ui -> 0']);
      expect(await Bun.file(join(dir, FILE)).text()).toBe(
        'export const P = {\n  realtime: 1,\n};\n',
      );
    });
  });

  test('a key with a metacharacter lowers its own quoted row, never a neighbour it matches', async () => {
    await withPins('export const P = {\n  axb: 4,\n  "a.b": 3,\n};\n', async (dir) => {
      expect(await applyUnpin(dir, FILE, ['a.b'], { 'a.b': 1 }, { axb: 4, 'a.b': 3 })).toEqual([
        'a.b -> 1',
      ]);
      const after = await Bun.file(join(dir, FILE)).text();
      expect(after).toContain('"a.b": 1');
      expect(after).toContain('axb: 4');
    });
  });

  test('a quoted key at zero loses its whole row', async () => {
    const pins = { 'create-ultimate': 2, ui: 1 };
    await withPins("export const P = {\n  'create-ultimate': 2,\n  ui: 1,\n};\n", async (dir) => {
      expect(await applyUnpin(dir, FILE, ['create-ultimate'], {}, pins)).toEqual([
        'create-ultimate -> 0',
      ]);
      const after = await Bun.file(join(dir, FILE)).text();
      expect(after).not.toContain('create-ultimate');
      expect(after).toContain('ui: 1');
    });
  });

  test('a row with a reason: count lowered in place; the whole entry deleted at zero', async () => {
    const text = [
      'export const P = {',
      '  jobs: {',
      '    count: 5,',
      "    reason: 'a fixture, with a }, inside',",
      '  },',
      "  time: { count: 1, reason: 'one line' },",
      '};',
      '',
    ].join('\n');
    const pins = { jobs: { count: 5, reason: 'r' }, time: { count: 1, reason: 'r' } };
    await withPins(text, async (dir) => {
      expect(await applyUnpin(dir, FILE, ['jobs'], { jobs: 2 }, pins)).toEqual(['jobs -> 2']);
      expect(await Bun.file(join(dir, FILE)).text()).toContain('    count: 2,');
      expect(await applyUnpin(dir, FILE, ['time', 'jobs'], {}, pins)).toEqual([
        'time -> 0',
        'jobs -> 0',
      ]);
      expect(await Bun.file(join(dir, FILE)).text()).toBe('export const P = {\n};\n');
    });
  });
});
