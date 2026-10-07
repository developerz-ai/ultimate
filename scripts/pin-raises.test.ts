import { describe, expect, test } from 'bun:test';
// why: Bun has no recursive rm of its own; the scratch copy of a pins module is removed after.
import { rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); the scratch copy must live outside the checkout.
import { tmpdir } from 'node:os';
import { BASE_REF, baseRef } from './lib/base-ref';
import { importPinSource, pinRows } from './lib/pin-rows';
import {
  expectedRedLine,
  expectedRedRows,
  PIN_FILES,
  PIN_GLOB,
  SCRIPT_PIN_TABLES,
  sitesRows,
  tableDeclaration,
} from './lib/pin-tables';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { checkPinRaises, pinRaiseResult, readPinTables, rowLine, whyStatement } from './pin-raises';

const PATH = 'scripts/lib/demo-pins.ts';

const table = (
  source: string,
  now: Record<string, number>,
  base?: Record<string, number>,
  baseSource?: string,
) => ({
  path: PATH,
  source,
  now: new Map(Object.entries(now)),
  base: base === undefined ? undefined : new Map(Object.entries(base)),
  ...(baseSource === undefined ? {} : { baseSource }),
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

  test('a table wholly RE-KEYED, total not above the base, is stated by a NEW header why:', () => {
    // Per-package counts re-keyed per site: every row is new, and no row is a raise in substance.
    const old = `// The ratchet under x.\n${FLAT}`;
    const site = [
      '// The ratchet under x.',
      '// why: re-keyed per site in sweep 11c, the same 15 sites.',
      'export const DEMO_PINS = {',
      "  'cli: a.ts': 12,",
      "  'core: b.ts': 3,",
      '};',
    ].join('\n');
    const now = { 'DEMO_PINS.cli: a.ts': 12, 'DEMO_PINS.core: b.ts': 3 };
    const base = { 'DEMO_PINS.cli': 12, 'DEMO_PINS.core': 3 };
    expect(checkPinRaises([table(site, now, base, old)])).toEqual([]);
    // No header why: — every new row is a raise from zero, as before.
    expect(
      checkPinRaises([
        table(`// The ratchet under x.\n${site.split('\n').slice(2).join('\n')}`, now, base, old),
      ]),
    ).toHaveLength(2);
    // The header why: the base already had states nothing.
    expect(checkPinRaises([table(site, now, base, site)])).toHaveLength(2);
    // A re-key that GROWS the total is a raise smuggled through a rename.
    const grown = { ...now, 'DEMO_PINS.core: b.ts': 4 };
    expect(checkPinRaises([table(site, grown, base, old)])).toHaveLength(2);
    // Only the page-to-site migration: a base ALREADY keyed per site gets no re-key exemption,
    // or later debt could replace existing debt under a fresh header sentence.
    const siteBase = { 'DEMO_PINS.cli: old.ts': 12, 'DEMO_PINS.core: old.ts': 3 };
    expect(checkPinRaises([table(site, now, siteBase, old)])).toHaveLength(2);
    // One key kept is not a re-key: the rows are compared one by one.
    const kept = { 'DEMO_PINS.cli': 12, 'DEMO_PINS.core: b.ts': 3 };
    expect(checkPinRaises([table(site, kept, base, old)]).map((raise) => raise.row)).toEqual([
      'DEMO_PINS.core: b.ts',
    ]);
  });

  test('a raise under the why: the base already had is UNSTATED — an old reason licenses nothing', () => {
    // The pin went 3 -> 30 and the sentence above it is the one written for the 3.
    const was = FLAT_WHY;
    const now = FLAT_WHY.replace('cli: 12', 'cli: 30');
    const raises = checkPinRaises([
      table(now, { 'DEMO_PINS.cli': 30 }, { 'DEMO_PINS.cli': 12 }, was),
    ]);
    expect(raises.map((raise) => raise.row)).toEqual(['DEMO_PINS.cli']);
    // A new sentence for the new number states it.
    const restated = now.replace('fixed by slice 15', 'and the 18 the scanner gained in slice 16');
    expect(
      checkPinRaises([table(restated, { 'DEMO_PINS.cli': 30 }, { 'DEMO_PINS.cli': 12 }, was)]),
    ).toEqual([]);
  });

  test('a nested row whose reason did not change is unstated too', () => {
    const now = NESTED.replace('count: 12', 'count: 40');
    expect(
      checkPinRaises([table(now, { 'DEMO_PINS.cli': 40 }, { 'DEMO_PINS.cli': 12 }, NESTED)]),
    ).toHaveLength(1);
  });

  test('a why: comment wrapped over several lines above the row states it', () => {
    const source = [
      'export const DEMO_PINS = {',
      '  // why: the record moved verbatim with its history (plan 101 slice 17 f,',
      '  // 2026-09-23); it quotes the commands its rules were written against.',
      '  cli: 12,',
      '};',
    ].join('\n');
    expect(
      checkPinRaises([table(source, { 'DEMO_PINS.cli': 12 }, { 'DEMO_PINS.cli': 3 })]),
    ).toEqual([]);
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

  test('a pins module with a relative import loads from its scratch copy', async () => {
    // `coverage-pins.ts` imports its bar by a relative path; copied to a scratch directory
    // unrewritten, that import resolved against the scratch directory and the whole run crashed.
    const scratch = `${tmpdir()}/pin-rows-test-${process.pid}`;
    const source = [
      "import { BASE_REF } from './base-ref';",
      'export const DEMO_PINS = { [BASE_REF]: 2 };',
    ].join('\n');
    try {
      const loaded = await importPinSource(
        source,
        scratch,
        `${repoRoot()}/scripts/lib/demo-pins.ts`,
      );
      expect([...pinRows(loaded)]).toEqual([[`DEMO_PINS.${BASE_REF}`, 2]]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('rowLine finds a quoted key and a pkg: row, and 0 for a row it cannot place', () => {
    expect(rowLine("const T = {\n  'a-b': 1,\n};", 'T.a-b')).toBe(2);
    expect(rowLine("const T = [\n  { pkg: 'ui', count: 2 },\n];", 'T.ui')).toBe(2);
    expect(rowLine('const T = {};', 'T.nope')).toBe(0);
    expect(whyStatement('', 0)).toBeUndefined();
  });

  test('a checkout that cannot get origin/main is refused, never green', () => {
    const result = pinRaiseResult([], undefined);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((one) => one.code)).toEqual(['X_PIN_BASE_MISSING']);
  });
});

describe('the tables that live inside a script', () => {
  test('the widened file list names every table whose header says it may only shrink', () => {
    expect(PIN_FILES).toEqual([
      'scripts/lib/*-pins.ts',
      'scripts/doc-commands.ts',
      'scripts/readme-fences-backlog.ts',
      'scripts/lib/gated-apps.ts',
      'scripts/posix-relative.ts',
      'scripts/set-cookie-literals.ts',
      'scripts/factory-names-pins.ts',
      'scripts/wiki-fences-backlog.ts',
    ]);
  });

  // Sweep 11 R4: `posix-relative.ts`'s `BACKLOG` and `set-cookie-literals.ts`'s `SET_COOKIE_PINS`
  // were outside the list, so a raise on either needed no `why:`. The list is held complete by
  // reading every script for an exported literal ratchet, not by remembering to add one.
  test('every exported *_PINS / *BACKLOG literal in a script is a table pin-raises compares', async () => {
    const glob = new Bun.Glob(PIN_GLOB);
    const listed = new Set(SCRIPT_PIN_TABLES.map((one) => `${one.path} ${one.table}`));
    const missing: string[] = [];
    for (const path of new Bun.Glob('scripts/**/*.ts').scanSync({ cwd: repoRoot() })) {
      const posix = path.split('\\').join('/');
      if (posix.endsWith('.test.ts') || glob.match(posix)) continue;
      const source = await Bun.file(`${repoRoot()}/${posix}`).text();
      // A LITERAL only: `ERROR_STATUS_BACKLOG = merged(…)` is computed, and its debt is
      // size-pinned by `error-map-backlog.test.ts`; `STATUS_BACKLOG` is a path string.
      for (const match of source.matchAll(
        /^export const ([A-Z_]*(?:PINS|BACKLOG))\b[^=]*=\s*[{[]/gm,
      )) {
        const row = `${posix} ${match[1]}`;
        if (!listed.has(row)) missing.push(row);
      }
    }
    expect(missing).toEqual([]);
  });

  test('a { sites, why } row is worth its sites, so raising one is a raise', () => {
    expect([
      ...sitesRows('SET_COOKIE_PINS')({ 'packages/a.ts': { sites: 3, why: 'x' }, bad: 1 }),
    ]).toEqual([['SET_COOKIE_PINS.packages/a.ts', 3]]);
  });

  test('one table is lifted out of a script, a brace inside a string or comment included', () => {
    const source = [
      "import { x } from '@ultimat3/cli';",
      'export const DOC_PINS: Readonly<Record<string, number>> = {',
      "  // a } in a comment (and a ')' too)",
      "  'a}.md': 1,",
      '};',
      'export const after = 2;',
    ].join('\n');
    expect(tableDeclaration(source, 'DOC_PINS')).toBe(
      "export const DOC_PINS = {\n  // a } in a comment (and a ')' too)\n  'a}.md': 1,\n};\n",
    );
    expect(tableDeclaration(source, 'MISSING')).toBeUndefined();
    expect(tableDeclaration('export const N = 3;', 'N')).toBeUndefined();
  });

  test('an expectedRed step is one row per app, placed under that app', () => {
    const source = [
      'export const GATED_APPS = [',
      "  { dir: 'a', expectedRed: { drift: 'x' } },",
      '  {',
      "    dir: 'b',",
      '    expectedRed: {',
      "      drift: 'y',",
      '    },',
      '  },',
      '];',
    ].join('\n');
    const rows = expectedRedRows([
      { dir: 'a', expectedRed: { drift: 'x' } },
      { dir: 'b', expectedRed: { drift: 'y' } },
      { dir: 'c' },
      null,
    ]);
    expect([...rows]).toEqual([
      ['GATED_APPS.a.drift', 1],
      ['GATED_APPS.b.drift', 1],
    ]);
    expect(expectedRedRows({})).toEqual(new Map());
    expect(expectedRedLine(source, 'GATED_APPS.b.drift')).toBe(6);
    expect(expectedRedLine(source, 'GATED_APPS.z.drift')).toBe(0);
    // A new red step with no why: is a raise from zero, and reported at its own line.
    const raises = checkPinRaises([
      {
        path: 'scripts/lib/gated-apps.ts',
        source,
        now: rows,
        base: new Map(),
        baseSource: 'export const GATED_APPS = [];',
        line: expectedRedLine,
      },
    ]);
    expect(raises.map((raise) => `${raise.row}:${raise.line}`)).toEqual([
      'GATED_APPS.a.drift:2',
      'GATED_APPS.b.drift:6',
    ]);
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
      // The script-held tables are read too, not only the `*-pins.ts` glob.
      const paths = tables.map((one) => one.path);
      expect(paths).toContain('scripts/doc-commands.ts');
      expect(paths).toContain('scripts/readme-fences-backlog.ts');
      expect(paths).toContain('scripts/lib/gated-apps.ts');
      const docs = tables.find((one) => one.path === 'scripts/doc-commands.ts');
      expect(
        docs?.now.get('DOC_COMMAND_PINS.docs/history/cli.md: x db branch <name>'),
      ).toBeGreaterThan(0);
      // Non-vacuity: the tables were read at both ends and hold rows.
      expect(tables.length).toBeGreaterThan(5);
      expect(tables.filter((one) => one.base !== undefined).length).toBeGreaterThan(5);
      expect(tables.reduce((sum, one) => sum + one.now.size, 0)).toBeGreaterThan(20);
      expect(pinRaiseResult(tables, base).findings ?? []).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test(
    'the command itself loads, runs and answers one JSON document',
    async () => {
      // The pure halves above were green while `bun run pin-raises` died on its first import: a
      // rule whose command cannot start verifies nothing, so the command is what this runs.
      const ran = await run(['bun', 'run', 'scripts/pin-raises.ts', '--json'], { cwd: repoRoot() });
      const answer: unknown = JSON.parse(ran.output.trim().split('\n').at(-1) ?? '');
      expect(answer).toMatchObject({ script: 'pin-raises', data: { base: BASE_REF } });
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
