// The scaffolder had no test at all, and it shipped two defects a test would have caught on the
// first run: a boundary doc derived from the tier TABLE (which a package being created is not in
// yet), and a `--tier` parsed with no guard.

import { describe, expect, test } from 'bun:test';
import { PACKAGE_FILES } from '@ultimat3/cli';
import { allowedTiersFor, TIERS } from './lib/tiers';
import { packageTemplates, TIER_NUMBERS, tierProblem, withPackageReference } from './new-package';

const fileNamed = (name: string, tier: number, path: string): string => {
  const file = packageTemplates(name, tier, 'one line').find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`no ${path} in the templates`);
  return file.contents;
};

describe('unit · a scaffolded package documents its OWN boundary', () => {
  // `allowedTiersFor(name)` resolved through `tierOf('widgets')` -> UNLISTED_TIER (6), so every
  // scaffolded package's CLAUDE.md said "May import tiers 0-5" whatever `--tier` asked for — and
  // an agent following it would import @ultimat3/render from a tier-1 package.
  test('the allowed range comes from the tier given, not from the package name', () => {
    expect(fileNamed('widgets', 1, 'CLAUDE.md')).toContain('Tier 1. May import tiers 0-0.');
    expect(fileNamed('widgets', 3, 'CLAUDE.md')).toContain('Tier 3. May import tiers 0-2.');
    expect(fileNamed('widgets', 1, 'README.md')).toContain('Tier 1. May import tiers 0-0 only');
    expect(fileNamed('widgets', 0, 'CLAUDE.md')).toContain('May import tiers 0-0');
  });

  test('the range agrees with the table every other check reads', () => {
    for (const tier of TIER_NUMBERS) {
      expect(fileNamed('widgets', tier, 'CLAUDE.md')).toContain(
        `Tier ${tier}. May import tiers ${allowedTiersFor(tier)}.`,
      );
    }
  });

  test('every contract file the package-shape step demands is emitted', () => {
    const paths = packageTemplates('widgets', 1, 'one line').map((file) => file.path);
    for (const required of PACKAGE_FILES) expect(paths).toContain(required);
    expect(paths).toContain('LICENSE');
  });

  test('the scaffolded error class carries a namespaced code and a docs url', () => {
    const errors = fileNamed('widget-set', 1, 'src/errors.ts');
    expect(errors).toContain("'X_WIDGET_SET_INVALID'");
    expect(errors).toContain('https://ultimate.dev/errors/X_WIDGET_SET_INVALID');
    expect(errors).toContain('extends UltimateError');
  });
});

/**
 * A scaffolded package got a `tsconfig.json` and no line in the root solution, so `tsc -b` — the
 * `typecheck` step's whole implementation — compiled every project the root REFERENCES and walked
 * past the new one. The same hole `scripts/` itself sat in: a workspace outside the build graph
 * typechecks nowhere, and nothing said so.
 */
describe('unit · a scaffolded package joins the root build graph', () => {
  const root = (...paths: readonly string[]): string =>
    `${JSON.stringify({ files: [], references: paths.map((path) => ({ path })) }, null, 2)}\n`;

  test('the new package is added to the root references, in sorted order', () => {
    const next = withPackageReference(root('./packages/core', './scripts'), 'jobs') ?? '';
    expect(JSON.parse(next)).toEqual({
      files: [],
      references: [{ path: './packages/core' }, { path: './packages/jobs' }, { path: './scripts' }],
    });
    // Two spaces and a trailing newline, so re-scaffolding never shows up as a whitespace diff.
    expect(next).toBe(root('./packages/core', './packages/jobs', './scripts'));
  });

  test('an entry that is already there is left exactly as it was', () => {
    const source = root('./packages/core');
    expect(withPackageReference(source, 'core')).toBe(source);
  });

  test('a root config this cannot parse is returned untouched, never half-rewritten', () => {
    expect(withPackageReference('{ "references": [ // a comment\n]}', 'jobs')).toBeUndefined();
    expect(withPackageReference(JSON.stringify({ files: [] }), 'jobs')).toBeUndefined();
  });
});

describe('unit · --tier is a tier or a refusal', () => {
  // `--tier abc` was `Number.parseInt`'d to NaN and written into the docs as "Tier NaN".
  test('a non-numeric or out-of-table tier is refused', () => {
    expect(tierProblem('abc')).toContain('not one of');
    expect(tierProblem('9')).toContain('not one of');
    expect(tierProblem('1.5')).toContain('not one of');
    expect(tierProblem('')).toContain('not one of');
  });

  test('every tier in the table passes, and an absent flag is not a problem', () => {
    for (const tier of Object.keys(TIERS)) expect(tierProblem(tier)).toBeUndefined();
    expect(tierProblem(undefined)).toBeUndefined();
  });
});
