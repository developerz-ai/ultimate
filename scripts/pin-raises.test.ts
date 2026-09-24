import { describe, expect, test } from 'bun:test';
import { BASE_REF, baseRef } from './lib/base-ref';
import { pinRows } from './lib/pin-rows';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkPinRaises, pinRaiseResult, readPinTables, rowLine, statesWhy } from './pin-raises';

const PATH = 'scripts/lib/demo-pins.ts';

const table = (source: string, now: Record<string, number>, base?: Record<string, number>) => ({
  path: PATH,
  source,
  now: new Map(Object.entries(now)),
  base: base === undefined ? undefined : new Map(Object.entries(base)),
});

const FLAT = ['export const DEMO_PINS = {', '  cli: 12,', '  core: 3,', '};'].join('\n');
const FLAT_WHY = [
  'export const DEMO_PINS = {',
  '  // why: the new sites are the release preflight, fixed by slice 15',
  '  cli: 12,',
  '  core: 3,',
  '};',
].join('\n');
const NESTED = [
  'export const DEMO_PINS = {',
  '  cli: {',
  '    count: 12,',
  "    reason: 'why: the CDP driver has no Bun native yet',",
  '  },',
  '};',
].join('\n');

describe('unit · a ratchet pin that rises needs a why: on the row', () => {
  test('a silent raise is reported with the row, the old and the new count', () => {
    const raises = checkPinRaises([
      table(
        FLAT,
        { 'DEMO_PINS.cli': 12, 'DEMO_PINS.core': 3 },
        { 'DEMO_PINS.cli': 10, 'DEMO_PINS.core': 3 },
      ),
    ]);
    expect(raises).toEqual([{ path: PATH, row: 'DEMO_PINS.cli', line: 2, was: 10, now: 12 }]);
    const result = pinRaiseResult(
      [table(FLAT, { 'DEMO_PINS.cli': 12 }, { 'DEMO_PINS.cli': 10 })],
      BASE_REF,
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_PIN_RAISE_UNSTATED');
    expect(result.findings?.[0]?.cause).toContain('DEMO_PINS.cli rose 10→12');
  });

  test('a why: directly above the row, or inside it, states the raise', () => {
    expect(
      checkPinRaises([table(FLAT_WHY, { 'DEMO_PINS.cli': 12 }, { 'DEMO_PINS.cli': 10 })]),
    ).toEqual([]);
    expect(checkPinRaises([table(NESTED, { 'DEMO_PINS.cli': 12 }, {})])).toEqual([]);
  });

  test('a why: on a NEIGHBOURING row states nothing for this one', () => {
    const source = FLAT_WHY.replace('  cli: 12,\n  core: 3,', '  cli: 12,\n  core: 4,');
    expect(
      checkPinRaises([table(source, { 'DEMO_PINS.core': 4 }, { 'DEMO_PINS.core': 3 })]).map(
        (raise) => raise.row,
      ),
    ).toEqual(['DEMO_PINS.core']);
  });

  test('a new table whose header says why states every row it opens with', () => {
    const header = `// The ratchet under x.\n// why: 33 stale lines measured the day the rule landed.\n${FLAT}`;
    expect(checkPinRaises([table(header, { 'DEMO_PINS.cli': 12 })])).toEqual([]);
    // And only a NEW table: a header cannot state a later raise of an existing row.
    expect(
      checkPinRaises([table(header, { 'DEMO_PINS.cli': 12 }, { 'DEMO_PINS.cli': 10 })]),
    ).toHaveLength(1);
  });

  test('a new row, or a new table, is a raise from zero; a lowered one is not a raise', () => {
    expect(checkPinRaises([table(FLAT, { 'DEMO_PINS.core': 3 })])[0]?.was).toBe(0);
    expect(checkPinRaises([table(FLAT, { 'DEMO_PINS.cli': 9 }, { 'DEMO_PINS.cli': 12 })])).toEqual(
      [],
    );
  });

  test('rows are read out of every table shape the pins files use', () => {
    const rows = pinRows({
      COUNTS: { cli: 3 },
      NESTED: { cli: { count: 4, reason: 'r' } },
      LICENCES: { 'jobs.driver': 'a sentence' },
      LISTED: [{ pkg: 'ui', count: 2, reason: 'r' }],
      helper: () => 1,
    });
    expect([...rows]).toEqual([
      ['COUNTS.cli', 3],
      ['NESTED.cli', 4],
      ['LICENCES.jobs.driver', 1],
      ['LISTED.ui', 2],
    ]);
  });

  test('rowLine finds a quoted key and a pkg: row, and 0 for a row it cannot place', () => {
    expect(rowLine("const T = {\n  'a-b': 1,\n};", 'T.a-b')).toBe(2);
    expect(rowLine("const T = [\n  { pkg: 'ui', count: 2 },\n];", 'T.ui')).toBe(2);
    expect(rowLine('const T = {};', 'T.nope')).toBe(0);
    expect(statesWhy('', 0)).toBe(false);
  });

  test('a checkout that cannot get origin/main is refused, never green', () => {
    const result = pinRaiseResult([], undefined);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((one) => one.code)).toEqual(['X_PIN_BASE_MISSING']);
  });
});

describe('the real tree, against origin/main', () => {
  test(
    'every pin raised since origin/main states why',
    async () => {
      const root = repoRoot();
      const base = await baseRef(root);
      expect(base).toBe(BASE_REF);
      const tables = await readPinTables(root, BASE_REF);
      // Non-vacuity: the tables were read at both ends and hold rows.
      expect(tables.length).toBeGreaterThan(5);
      expect(tables.filter((one) => one.base !== undefined).length).toBeGreaterThan(5);
      expect(tables.reduce((sum, one) => sum + one.now.size, 0)).toBeGreaterThan(20);
      expect(pinRaiseResult(tables, base).findings ?? []).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
