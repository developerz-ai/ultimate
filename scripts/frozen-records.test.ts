// The enforcement half of `scripts/frozen-records.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `const X: Readonly<Record<ClosedKey, V>> =
// Object.freeze({…})` re-entering the tree fails `bun run verify` with no extra wiring.
//
// The failure cases come first, and the real repo is asserted NON-VACUOUSLY: a scan that matched
// nothing answers exactly what a clean tree answers, which is the trap both of this repo's other
// source-scanning guards had to be built against.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './frozen-records';
import { checkFrozenRecords, isOpenKey, readSources, recordKeyType } from './frozen-records';
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
    // is the same silence as a broken scan, and it should have to be looked at.
    expect(counts.explicit).toBeGreaterThanOrEqual(21);
    expect(counts['annotated-open']).toBeGreaterThanOrEqual(4);
    expect(counts.unconstrained).toBeGreaterThan(20);
  });
});
