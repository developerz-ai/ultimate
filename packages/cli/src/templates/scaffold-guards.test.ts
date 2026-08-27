// The four guards `x new` ships, driven as the gate drives them: written to disk, imported through
// the same `guardFindings` seam `x verify`'s `boundaries` step calls, and pointed at a real tree.
//
// Asserting on the template STRINGS would prove nothing — the defect this closes is that
// `AGENTS.md` stated nine rules and five of them were enforced by no code at all, which is exactly
// what a string comparison cannot see. So each rule is proven twice: it fires on the mistake, and
// it stays silent on the scaffold `x new` actually writes.

import { describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { planNewApp } from '../cmd-new';
import { guardFindings, guardPaths } from '../guards';
import type { Finding } from '../output';
import { scaffoldGuardFiles } from './scaffold-guards';

/** The scaffold's own files, written to a temp root — the tree every case below starts from. */
async function scaffoldInto(dir: string): Promise<void> {
  for (const file of planNewApp({ name: 'guard-demo', example: true })) {
    await Bun.write(join(dir, file.path), file.contents);
  }
}

/** One extra file on top of the scaffold, then the gate's own guard pass over the result. */
async function findingsWith(files: Readonly<Record<string, string>>): Promise<readonly Finding[]> {
  const dir = mkdtempSync(join(tmpdir(), 'x-guards-'));
  try {
    await scaffoldInto(dir);
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(dir, path), contents);
    }
    return await guardFindings(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (findings: readonly Finding[]): readonly string[] => findings.map((f) => f.code);

describe('unit · x new · the guards it ships', () => {
  test('every guard is a file the gate discovers, and each has its own test', () => {
    const paths = scaffoldGuardFiles().map((file) => file.path);
    expect(paths.filter((path) => !path.endsWith('.test.ts'))).toEqual([
      'guards/bare-error.ts',
      'guards/raw-colour.ts',
      'guards/untranslated-string.ts',
      'guards/unzoned-date.ts',
    ]);
    for (const rule of paths.filter((path) => !path.endsWith('.test.ts'))) {
      expect(paths).toContain(rule.replace(/\.ts$/, '.test.ts'));
    }
  });

  // The seam, not a string: `guardPaths` is what the `boundaries` step enumerates, and a guard the
  // scaffold writes into a directory the gate does not read is a rule that does not exist.
  test('the gate enumerates all four and never their tests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-guards-'));
    try {
      await scaffoldInto(dir);
      expect(await guardPaths(dir)).toEqual([
        'guards/bare-error.ts',
        'guards/raw-colour.ts',
        'guards/untranslated-string.ts',
        'guards/unzoned-date.ts',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // The load-bearing one, and the reason this suite is slow: a pristine `x new` tree must be
  // SILENT. A guard that reports on the scaffold's own files is a scaffold whose first `x verify`
  // is red for something the author did not write, which is worse than the rule being absent.
  test('a pristine scaffold trips none of them', async () => {
    expect(await findingsWith({})).toEqual([]);
  }, 30_000);
});

describe('unit · x new · each shipped guard refuses the mistake it names', () => {
  // The exact five `AGENTS.md` states and `x verify` used to pass, one per case. Each was measured
  // green on a scaffold built against the published 7.0.0 packages before these guards existed.
  test('a raw hex in a stylesheet is X_RAW_COLOUR', async () => {
    const findings = await findingsWith({
      'apps/web/site/page.module.scss': '.hero {\n  color: #ff0000;\n}\n',
    });
    expect(codes(findings)).toEqual(['X_RAW_COLOUR']);
    expect(findings[0]?.cause).toContain('#ff0000');
    expect(findings[0]?.fix).toContain('tokens.role');
  }, 30_000);

  test('a date formatted with no timeZone is X_UNZONED_DATE', async () => {
    const findings = await findingsWith({
      'apps/web/app/dashboard/shown.ts':
        "export const shown = (at: Date) => at.toLocaleDateString('en-US');\n",
    });
    expect(codes(findings)).toEqual(['X_UNZONED_DATE']);
    expect(findings[0]?.fix).toContain('timeZone');
  }, 30_000);

  test('an explicit IANA zone satisfies the same rule', async () => {
    const findings = await findingsWith({
      'apps/web/app/dashboard/shown.ts':
        "export const shown = (at: Date) => at.toLocaleDateString('en-US', { timeZone: 'UTC' });\n",
    });
    expect(findings).toEqual([]);
  }, 30_000);

  test('a bare throw in a repo is X_BARE_ERROR', async () => {
    // Assembled from tokens, never written out: `scripts/test-bare-error.ts` reads a bare throw
    // in a test file as that test stating its own verdict — and this one is the SUBJECT's source,
    // fed to the rule under test. Its scanner exempts string literals and not comments, so the
    // shape may not be spelled here in either place.
    const bare = `${['throw', 'new', 'Error'].join(' ')}('no post');`;
    const findings = await findingsWith({
      'apps/web/app/post/repo.ts': `export const byId = () => {\n  ${bare}\n};\n`,
    });
    expect(codes(findings)).toEqual(['X_BARE_ERROR']);
    expect(findings[0]?.cause).toContain(':2');
    expect(findings[0]?.fix).toContain('UltimateError');
  }, 30_000);

  test('a typed JSX string beside a t() call is X_UNTRANSLATED_STRING', async () => {
    const findings = await findingsWith({
      'apps/web/site/notice/page.tsx': [
        "import { defineRoute } from '@ultimat3/render';",
        "import { t } from '@ultimat3/i18n';",
        'export const config = defineRoute({',
        "  render: 'static',",
        "  hydrate: 'never',",
        "  offline: 'precache',",
        "  budget: { js: '0kb' },",
        "  meta: () => ({ title: t('x') }),",
        '});',
        'export function NoticePage() {',
        "  return <main><h1>{t('site.notice.title')}</h1><p>Read this first</p></main>;",
        '}',
        '',
      ].join('\n'),
    });
    expect(codes(findings)).toEqual(['X_UNTRANSLATED_STRING']);
    expect(findings[0]?.cause).toContain('Read this first');
  }, 30_000);

  // `x new` scaffolds a `packages/ui` workspace whose components render to a user, and the guard
  // scanned an app's own two surfaces only — so this exact file was green. The widened scan runs
  // TWO globs: `Bun.Glob.scan()` answers nothing at all for a pattern that BEGINS with a brace
  // group, so folding the two into one line would have turned the guard off, not widened it.
  test('a hardcoded string in the scaffolded packages/ui is reported too', async () => {
    const findings = await findingsWith({
      'packages/ui/src/banner.tsx': [
        'export function Banner() {',
        '  return <aside><p>Read this first</p></aside>;',
        '}',
        '',
      ].join('\n'),
    });
    expect(codes(findings)).toEqual(['X_UNTRANSLATED_STRING']);
    expect(findings[0]?.cause).toContain('Read this first');
  }, 30_000);

  // The reason the JSX rule reads a closing tag rather than the next `<`. Measured by mutation: a
  // pattern that stops at the next `<` reports this file AND reds the pristine-scaffold case above,
  // because every generic and every type annotation in the tree becomes a "typed string".
  test('a generic type argument in an island is not a typed string', async () => {
    const findings = await findingsWith({
      'apps/web/app/post/generic.island.tsx': [
        "import { createSignal } from 'solid-js';",
        "type SaveState = 'idle' | 'saved';",
        "const [state] = createSignal<SaveState>('idle');",
        'export const mount = (): SaveState => state();',
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  }, 30_000);
});
