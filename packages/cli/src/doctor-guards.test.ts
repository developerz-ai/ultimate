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
import { fsCodemodApp } from './codemods/engine-fs';
import { codemod as vendoredGuards } from './codemods/vendored-guards';
import {
  shippedGuardsProbe,
  vendoredGuardWarnings,
  vendoredShippedGuards,
  withGuardListing,
} from './doctor-guards';
import { fixProblem } from './error-contract';
import { GUARD_VENDORED_CODE } from './guards-built-in';
import { resolvingEdit } from './guards-vendored';
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
    ).toMatchObject([
      { name: 'bare-error', path: 'guards/bare-error.ts', identical: false },
      { name: 'raw-length', path: 'guards/raw-length.ts', identical: true },
    ]);
  });

  test('a current template is identical whatever line endings the checkout wrote', () => {
    const crlf = template('bare-error').replaceAll('\n', '\r\n');
    expect(vendoredShippedGuards([{ path: 'guards/bare-error.ts', source: crlf }])).toEqual([
      { name: 'bare-error', path: 'guards/bare-error.ts', identical: true },
    ]);
  });

  test("an older app's report-only repo-unbounded copy is a current form, not an edit", () => {
    const reportOnly = String(repoUnboundedGuardFiles('warning')[0]?.contents);
    expect(reportOnly).toContain("severity: 'warning',");
    expect(
      vendoredShippedGuards([{ path: 'guards/repo-unbounded.ts', source: reportOnly }]),
    ).toEqual([{ name: 'repo-unbounded', path: 'guards/repo-unbounded.ts', identical: true }]);
  });

  test('the probe reads the directory the gate reads, and never counts a test as a guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      await Bun.write(join(root, 'guards/raw-length.ts'), template('raw-length'));
      await Bun.write(join(root, 'guards/focus-visible.test.ts'), '');
      expect(await shippedGuardsProbe(root)).toEqual([
        { name: 'raw-length', path: 'guards/raw-length.ts', identical: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the listing rides beside the verdict and never moves it', () => {
    const red = { ok: false, command: 'doctor', summary: '1 finding(s)', data: { count: 1 } };
    const edited = {
      name: 'bare-error',
      path: 'guards/bare-error.ts',
      identical: false,
      diff: '-a\n+b\n',
    };
    const listed = withGuardListing(red, [
      { name: 'raw-length', path: 'guards/raw-length.ts', identical: true },
      edited,
    ]);
    expect([listed.ok, listed.summary]).toEqual([false, '1 finding(s)']);
    expect(listed.data).toEqual({
      count: 1,
      guards: {
        missing: [],
        differs: [{ name: 'bare-error', refresh: resolvingEdit(edited), diff: '-a\n+b\n' }],
        vendored: ['raw-length', 'bare-error'],
      },
    });
    expect(listed.lines?.[0]).toContain('2 shipped guard(s) still have a copy');
    expect(listed.lines?.at(-1)).toBe(`  ${resolvingEdit(edited)}`);
    expect(withGuardListing(red, []).lines).toBeUndefined();
  });

  test('every copy is one warning, at its file', () => {
    expect(vendoredGuardWarnings([])).toEqual([]);
    const [warning, ...rest] = vendoredGuardWarnings([
      { name: 'raw-length', path: 'guards/raw-length.ts', identical: true },
    ]);
    expect(rest).toEqual([]);
    expect(warning?.code).toBe(GUARD_VENDORED_CODE);
    expect(warning?.at).toBe('guards/raw-length.ts');
  });

  test('the doctor stays ok, the copies in data.warnings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-'));
    try {
      for (const name of SHIPPED_GUARD_NAMES) {
        await Bun.write(join(root, `guards/${name}.ts`), template(name));
      }
      const result = await reportDoctor(probe({ root }));
      expect([result.ok, result.findings]).toEqual([true, []]);
      const warnings = (result.data as { warnings: { code: string }[] }).warnings;
      expect(warnings.filter(({ code }) => code === GUARD_VENDORED_CODE)).toHaveLength(
        SHIPPED_GUARD_NAMES.length,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// After `x upgrade` the listing must not send the author back to `x upgrade`: a migrated app has
// nothing to list, and a copy still present is named with its diff and the edit that resolves it.
describe('unit · x doctor · what is left after the migration', () => {
  const withCopies = async (
    copies: Readonly<Record<string, string>>,
    body: (root: string) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-guards-left-'));
    try {
      for (const [path, text] of Object.entries(copies)) await Bun.write(join(root, path), text);
      await body(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('a migrated app lists nothing and warns of nothing, edited copies included', async () => {
    const tree: Record<string, string> = {};
    for (const name of SHIPPED_GUARD_NAMES) tree[`guards/${name}.ts`] = template(name);
    tree['guards/raw-fetch.ts'] = `${template('raw-fetch')}// our vendor client\n`;
    await withCopies(tree, async (root) => {
      await vendoredGuards.run(fsCodemodApp(root));
      const entries = await shippedGuardsProbe(root);
      expect(entries).toEqual([]);
      expect(vendoredGuardWarnings(entries)).toEqual([]);
      const result = await reportDoctor(probe({ root }));
      expect(result.data).toMatchObject({ guards: { missing: [], differs: [], vendored: [] } });
    });
  });

  test('an edited copy left is named with its diff and the edit that resolves it — never x upgrade', async () => {
    const edited = `${template('raw-fetch')}// our vendor client\n`;
    await withCopies({ 'guards/raw-fetch.ts': edited }, async (root) => {
      const entries = await shippedGuardsProbe(root);
      const listed = withGuardListing({ ok: true, command: 'doctor', summary: 'clean' }, entries);
      const [differ] = (listed.data as { guards: { differs: Record<string, string>[] } }).guards
        .differs;
      expect(differ?.['diff']).toContain('+// our vendor client');
      expect(differ?.['refresh']).toStartWith('mv guards/raw-fetch.ts guards/app-raw-fetch.ts');
      const [warning, ...rest] = vendoredGuardWarnings(entries);
      expect(rest).toEqual([]);
      expect(warning?.at).toBe('guards/raw-fetch.ts');
      expect(warning?.fix).toStartWith('mv guards/raw-fetch.ts guards/app-raw-fetch.ts');
      expect(warning?.fix).toContain('"raw-fetch": "off"');
      expect(fixProblem(warning?.fix ?? '')).toBeUndefined();
      for (const line of [...(listed.lines ?? []), warning?.fix ?? '']) {
        expect(line).not.toContain('x upgrade');
      }
    });
  });

  test('an identical copy left is one delete', async () => {
    await withCopies({ 'guards/raw-length.ts': template('raw-length') }, async (root) => {
      const [warning] = vendoredGuardWarnings(await shippedGuardsProbe(root));
      expect(warning?.fix).toStartWith('rm -f guards/raw-length.ts guards/raw-length.test.ts');
      expect(fixProblem(warning?.fix ?? '')).toBeUndefined();
    });
  });
});
