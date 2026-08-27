// The enforcement half of `scripts/frozen-records.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `const X: Readonly<Record<ClosedKey, V>> =
// Object.freeze({…})` re-entering the tree fails `bun run verify` with no extra wiring. The failure
// cases come first, and the real repo is asserted NON-VACUOUSLY.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './frozen-records';
import {
  aliasTable,
  checkFrozenRecords,
  expandAliases,
  isOpenKey,
  readSources,
  recordKeyType,
  scanFreezeSites,
} from './frozen-records';
import { repoRoot } from './lib/run';

const ROOT = repoRoot();

/** A known-good site, so the vacuity guard ("this scan recognises the correct form") is satisfied. */
const good: SourceFile = {
  at: 'packages/core/src/roles.ts',
  text: 'export const ROLE_INFO = Object.freeze<Record<Role, RoleInfo>>({\n  web: 1,\n});\n',
};

const file = (at: string, text: string): SourceFile => ({ at, text });

describe('a freeze that claims a closed set and does not enforce it', () => {
  test('is reported, and the finding names the key type it failed to close', () => {
    const { findings } = checkFrozenRecords([
      good,
      file(
        'packages/pwa/src/strategies.ts',
        'export const MODE_STRATEGY: Readonly<Record<RenderMode, StrategyName>> = Object.freeze({\n  static: 1,\n});\n',
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('packages/pwa/src/strategies.ts:1');
    expect(findings[0]?.cause).toContain('RenderMode');
    expect(findings[0]?.fix).toContain('Object.freeze<');
  });

  test('is reported when the annotation wraps onto its own line', () => {
    const wrapped =
      "const JOB_OUTCOME_LABELS: Readonly<Record<JobOutcome, 'ok' | null>> =\n  Object.freeze({\n    completed: 'ok',\n  });\n";
    expect(
      checkFrozenRecords([good, file('packages/jobs/src/worker.ts', wrapped)]).findings,
    ).toHaveLength(1);
  });

  test('is reported through Partial<> — missing keys are legal there, extra ones never were', () => {
    const partial =
      "export const ROUTE_FILENAME: Readonly<Partial<Record<Surface, string>>> = Object.freeze({\n  site: 'page.tsx',\n});\n";
    const { findings } = checkFrozenRecords([
      good,
      file('packages/render/src/registry.ts', partial),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('Surface');
  });

  test('is NOT reported once the type argument is spelled out', () => {
    const fixed =
      'export const MODE_STRATEGY = Object.freeze<Record<RenderMode, StrategyName>>({\n  static: 1,\n});\n';
    expect(checkFrozenRecords([good, file('packages/pwa/src/a.ts', fixed)]).findings).toEqual([]);
  });
});

describe('a closed key laundered through an alias', () => {
  const alias = file(
    'packages/pwa/src/capabilities.ts',
    'export type FrozenModes = Readonly<Record<RenderMode, StrategyName>>;\n',
  );

  test('is reported — the annotation NAMES the Record instead of spelling it', () => {
    const { findings } = checkFrozenRecords([
      good,
      alias,
      file(
        'packages/pwa/src/strategies.ts',
        'export const MODE_STRATEGY: FrozenModes = Object.freeze({\n  static: 1,\n});\n',
      ),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('packages/pwa/src/strategies.ts:1');
    expect(findings[0]?.cause).toContain('RenderMode');
  });

  test('is reported through a second hop', () => {
    const { findings } = checkFrozenRecords([
      good,
      alias,
      file('packages/pwa/src/b.ts', 'type ModeTable = FrozenModes;\n'),
      file(
        'packages/pwa/src/c.ts',
        'export const T: ModeTable = Object.freeze({\n  static: 1,\n});\n',
      ),
    ]);
    expect(findings).toHaveLength(1);
  });

  test('is NOT reported when the alias resolves to an OPEN key', () => {
    const report = checkFrozenRecords([
      good,
      file(
        'packages/i18n/src/catalog.ts',
        'export type Catalog = Readonly<Record<string, string>>;\n',
      ),
      file(
        'packages/i18n/src/en.ts',
        "export const EN: Catalog = Object.freeze({\n  a: 'b',\n});\n",
      ),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.counts['annotated-open']).toBe(1);
  });

  test('an OBJECT-TYPE alias that merely contains a Record is not one — nor a finding', () => {
    const report = checkFrozenRecords([
      good,
      file('packages/jobs/src/ctx.ts', 'export type Ctx = { rows: Readonly<Record<Mode, R>> };\n'),
      file('packages/jobs/src/a.ts', 'const ctx: Ctx = Object.freeze({\n  rows: 1,\n});\n'),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.counts.unconstrained).toBe(1);
    expect(aliasTable([file('a.ts', 'type Ctx = { r: Record<M, R> };\n')]).size).toBe(0);
  });

  test('is NOT borrowed from ANOTHER package that happens to share the type name', () => {
    // The false-finding class a repo-global table produced: `mail` writes its own `Config`, and the
    // finding named `RenderMode` — a type `mail` neither declares nor imports.
    const report = checkFrozenRecords([
      good,
      file(
        'packages/pwa/src/modes.ts',
        'export type Config = Readonly<Record<RenderMode, string>>;\n',
      ),
      file(
        'packages/mail/src/config.ts',
        "export type Config = { host: string };\nexport const MAIL: Config = Object.freeze({\n  host: 'x',\n});\n",
      ),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.counts.unconstrained).toBe(1);
  });

  test('is NOT resolved when ONE package declares the name twice with two bodies', () => {
    const report = checkFrozenRecords([
      good,
      file('packages/jobs/src/a.ts', 'export type Table = Readonly<Record<Outcome, string>>;\n'),
      file('packages/jobs/src/b.ts', 'type Table = ReadonlyArray<string>;\n'),
      file('packages/jobs/src/c.ts', "const T: Table = Object.freeze({\n  ok: 'x',\n});\n"),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.counts.unconstrained).toBe(1);
    expect(
      aliasTable([
        file('packages/jobs/src/a.ts', 'type Table = Readonly<Record<Outcome, string>>;\n'),
        file('packages/jobs/src/b.ts', 'type Table = ReadonlyArray<string>;\n'),
      ]).has('Table'),
    ).toBe(false);
  });

  test('an interface annotation is still left alone — an alias table has no entry for one', () => {
    const report = checkFrozenRecords([
      good,
      file(
        'packages/core/src/clock.ts',
        'export const systemClock: Clock = Object.freeze({\n  now: 1,\n});\n',
      ),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.counts.unconstrained).toBe(1);
  });
});

describe('a freeze the old scan could not see', () => {
  test('is reported when the declaration is INDENTED inside a namespace', () => {
    const nested =
      'export namespace Compat {\n' +
      '  export const MODES: Readonly<Record<RenderMode, S>> = Object.freeze({\n' +
      '    static: 1,\n' +
      '  });\n' +
      '}\n';
    const { findings } = checkFrozenRecords([good, file('packages/pwa/src/compat.ts', nested)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('packages/pwa/src/compat.ts:2');
  });

  test('is NOT reported when it is QUOTED inside a template literal', () => {
    const template =
      'export const tpl = `\n' +
      'export const MODES: Readonly<Record<RenderMode, S>> = Object.freeze({\n' +
      '  static: 1,\n' +
      '});\n' +
      '`;\n';
    expect(
      checkFrozenRecords([good, file('packages/cli/src/templates/a.ts', template)]).findings,
    ).toEqual([]);
  });

  test('is NOT reported when it is COMMENTED OUT', () => {
    const commented =
      '// export const MODES: Readonly<Record<RenderMode, S>> = Object.freeze({ static: 1 });\n';
    expect(checkFrozenRecords([good, file('packages/pwa/src/a.ts', commented)]).findings).toEqual(
      [],
    );
  });
});

describe('a genuinely open table is left alone', () => {
  test('Record<string, V> is not a finding — every key is already known', () => {
    const open =
      'export const DB_SQLSTATE_CODES: Readonly<Record<string, DbSqlStateCode>> = Object.freeze({\n  23505: 1,\n});\n';
    const report = checkFrozenRecords([good, file('packages/db/src/sqlstate.ts', open)]);
    expect(report.findings).toEqual([]);
    expect(report.counts['annotated-open']).toBe(1);
  });

  test('a key union with `string` anywhere in it is open', () => {
    expect(isOpenKey('string')).toBe(true);
    expect(isOpenKey("string | 'a'")).toBe(true);
    expect(isOpenKey('Role')).toBe(false);
  });

  test('an argument that is not an object literal has no freshness to lose', () => {
    const computed =
      'export const CORE_ERROR_CODES: Readonly<Record<CoreErrorCode, D>> = Object.freeze(\n  Object.fromEntries(entries),\n);\n';
    expect(checkFrozenRecords([good, file('packages/core/src/a.ts', computed)]).findings).toEqual(
      [],
    );
  });
});

describe('the outermost Record decides the key', () => {
  test('a nested Record value does not supply the key type', () => {
    expect(
      recordKeyType('Readonly<Record<MailToken, Readonly<Record<ColorScheme, string>>>>'),
    ).toBe('MailToken');
  });

  test('a multi-line generic still resolves', () => {
    expect(recordKeyType('Readonly<\n  Record<\n    StrategyName,\n    (r: R) => P\n  >\n>')).toBe(
      'StrategyName',
    );
  });

  test('an annotation with no Record supplies none', () => {
    expect(recordKeyType('Clock')).toBeUndefined();
  });
});

describe('the scan cannot pass by reading nothing', () => {
  test('no files at all is a finding, not a clean tree', () => {
    const { findings } = checkFrozenRecords([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('no Object.freeze at all');
  });

  test('recognising no CORRECT form is a finding — the scanner may be broken, not the tree', () => {
    const { findings } = checkFrozenRecords([
      file('packages/a/src/a.ts', 'const x = Object.freeze(y);\n'),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('no Object.freeze<T>');
  });
});

describe('this repository', () => {
  test('has no Object.freeze that admits an extra key in silence', async () => {
    const files = await readSources(ROOT);
    expect(checkFrozenRecords(files).findings).toEqual([]);
  });

  test('and the scan really read the tree, skipping tests', async () => {
    const files = await readSources(ROOT);
    const { counts } = checkFrozenRecords(files);
    expect(files.filter((one) => one.at.includes('.test.'))).toEqual([]);
    // Every closed-key table in the repo, spelled correctly. A number, not `> 0`: this dropping
    // is the same silence as a broken scan, and it should have to be looked at. `unconstrained`
    // was 42 while the scan matched at column 0 only; the seven it gained are the INDENTED
    // freezes — `context.ts`, `execute.ts`, `impersonate.ts` — that used to be invisible.
    expect(counts.explicit).toBeGreaterThanOrEqual(21);
    // 4 until 2026-08-27, and the one that left is the shape this floor exists to notice: core's
    // `SCHEMA_ERROR_CODE_TITLES` was `Object.freeze({ …four literal keys… })` and is now
    // `Object.freeze(Object.fromEntries(…))` over `@ultimat3/schema`'s own declarations, over the
    // declared `core -> schema` edge. It is not a freeze the scan lost sight of — it is a literal
    // that stopped existing, which is the direction this repo wants.
    expect(counts['annotated-open']).toBeGreaterThanOrEqual(3);
    expect(counts.unconstrained).toBeGreaterThanOrEqual(49);
  });

  test('and an INDENTED freeze in real source is one of the sites it sees', async () => {
    const at = 'packages/core/src/context.ts';
    const sites = scanFreezeSites(await Bun.file(`${ROOT}/${at}`).text(), at);
    expect(sites.map((one) => one.name)).toContain('services');
  });

  test('and its alias table resolves the one closed-key Record alias the tree declares', async () => {
    const aliases = aliasTable(await readSources(ROOT));
    expect(expandAliases('ResolvedCapabilities', aliases)).toContain('Record<');
    expect(recordKeyType(expandAliases('ResolvedCapabilities', aliases))).toBe('Capability');
    // An interface is not a type alias, so nothing laundered through one is reclassified.
    expect(expandAliases('Clock', aliases)).toBe('Clock');
  });
});
