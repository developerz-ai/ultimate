// The listing `x doctor` adds for an app that still holds copies of shipped guards: every shipped
// guard runs built in, so none is ever "missing"; each copy is named — identical or edited — with
// the one command that migrates them, and never turns the doctor red.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { reportDoctor } from './cmd-doctor';
import { probe } from './cmd-doctor-fixture';
import {
  MIGRATE_GUARDS,
  shippedGuardsProbe,
  vendoredGuardWarnings,
  vendoredShippedGuards,
  withGuardListing,
} from './doctor-guards';
import { GUARD_VENDORED_CODE } from './guards-built-in';
import { repoUnboundedGuardFiles } from './templates/guard-repo-unbounded';
import { SHIPPED_GUARD_NAMES, shippedGuardSource } from './templates/scaffold-guards';

const template = (name: string): string => shippedGuardSource(name) ?? '';

describe('unit · x doctor · copies of shipped guards', () => {
  test('an app with no guards/ holds no copy, and nothing is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      expect(await shippedGuardsProbe(root)).toEqual([]);
      const result = await reportDoctor(probe({ root }));
      expect(result.data).toMatchObject({ guards: { missing: [], differs: [], vendored: [] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a copy is named, identical or edited; the app’s own guards never are', () => {
    expect(
      vendoredShippedGuards([
        { path: 'guards/raw-length.ts', source: template('raw-length') },
        { path: 'guards/bare-error.ts', source: `${template('bare-error')}// edit\n` },
        { path: 'guards/migration-safety.ts', source: 'export {};' },
      ]),
    ).toEqual([
      { name: 'bare-error', identical: false },
      { name: 'raw-length', identical: true },
    ]);
  });

  test('a current template is identical whatever line endings the checkout wrote', () => {
    const crlf = template('bare-error').replaceAll('\n', '\r\n');
    expect(vendoredShippedGuards([{ path: 'guards/bare-error.ts', source: crlf }])).toEqual([
      { name: 'bare-error', identical: true },
    ]);
  });

  test("an older app's report-only repo-unbounded copy is a current form, not an edit", () => {
    const reportOnly = String(repoUnboundedGuardFiles('warning')[0]?.contents);
    expect(reportOnly).toContain("severity: 'warning',");
    expect(
      vendoredShippedGuards([{ path: 'guards/repo-unbounded.ts', source: reportOnly }]),
    ).toEqual([{ name: 'repo-unbounded', identical: true }]);
  });

  test('the probe reads the directory the gate reads, and never counts a test as a guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      await Bun.write(join(root, 'guards/raw-length.ts'), template('raw-length'));
      await Bun.write(join(root, 'guards/focus-visible.test.ts'), '');
      expect(await shippedGuardsProbe(root)).toEqual([{ name: 'raw-length', identical: true }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the listing rides beside the verdict and never moves it', () => {
    const red = { ok: false, command: 'doctor', summary: '1 finding(s)', data: { count: 1 } };
    const listed = withGuardListing(red, [
      { name: 'raw-length', identical: true },
      { name: 'bare-error', identical: false },
    ]);
    expect([listed.ok, listed.summary]).toEqual([false, '1 finding(s)']);
    expect(listed.data).toEqual({
      count: 1,
      guards: {
        missing: [],
        differs: [{ name: 'bare-error', refresh: MIGRATE_GUARDS }],
        vendored: ['raw-length', 'bare-error'],
      },
    });
    expect(listed.lines?.[0]).toContain('2 shipped guard(s) are copies');
    expect(listed.lines?.at(-1)).toBe(`  ${MIGRATE_GUARDS}`);
    expect(withGuardListing(red, []).lines).toBeUndefined();
  });

  test('every copy is one warning, whose fix is the migration', () => {
    expect(vendoredGuardWarnings([])).toEqual([]);
    const [warning, ...rest] = vendoredGuardWarnings([{ name: 'raw-length', identical: true }]);
    expect(rest).toEqual([]);
    expect(warning?.code).toBe(GUARD_VENDORED_CODE);
    expect(warning?.fix).toStartWith(MIGRATE_GUARDS);
  });

  test('the doctor stays ok, the copies in data.warnings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      for (const name of SHIPPED_GUARD_NAMES) {
        await Bun.write(join(root, `guards/${name}.ts`), template(name));
      }
      const result = await reportDoctor(probe({ root }));
      expect([result.ok, result.findings]).toEqual([true, []]);
      expect(result.data).toMatchObject({ warnings: [{ code: GUARD_VENDORED_CODE }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
