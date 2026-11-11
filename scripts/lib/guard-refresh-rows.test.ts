// The guard-refresh rule, pure: a changed shipped guard with no Upgrading row naming it, `x g guard`
// and a version of its range is red; the row makes it green. The real tree is asserted where the
// rule is hosted, `scripts/changelog-check.test.ts`.

import { describe, expect, test } from 'bun:test';
import { guardRefreshFinding } from './guard-refresh-git';
import {
  changedGuards,
  compareVersions,
  type GuardChange,
  guardRefreshGaps,
  pageUnits,
  unstatedGuards,
} from './guard-refresh-rows';

const SHIPPED = ['bare-error', 'native-confirm', 'raw-fetch', 'raw-fetch-extra'];
const T = 'packages/cli/src/templates';

describe('changedGuards', () => {
  test('a changed guard module is that guard; its test is not', () => {
    const paths = [`${T}/guard-bare-error.ts`, `${T}/guard-raw-fetch.test.ts`, `${T}/action.ts`];
    expect(changedGuards(paths, SHIPPED, () => [])).toEqual(['bare-error']);
  });

  test('a changed helper is every guard that imports it', () => {
    const importers = (stem: string) =>
      stem === 'local-binding' ? ['native-confirm', 'raw-fetch'] : [];
    expect(changedGuards([`${T}/guard-local-binding.ts`], SHIPPED, importers)).toEqual([
      'native-confirm',
      'raw-fetch',
    ]);
  });

  test('a deleted guard, no longer shipped and imported by none, changes nothing', () => {
    expect(changedGuards([`${T}/guard-gone.ts`], SHIPPED, () => [])).toEqual([]);
  });
});

describe('pageUnits', () => {
  test('a table row is one unit, a wrapped paragraph is one, a list item starts its own', () => {
    const page = '| a | b |\n| c | d |\n\none\ntwo\n- item\n  more\n## h\nlast';
    expect(pageUnits(page).map((unit) => [unit.line, unit.text])).toEqual([
      [1, '| a | b |'],
      [2, '| c | d |'],
      [4, 'one two'],
      [6, '- item   more'],
      [9, 'last'],
    ]);
  });
});

const RELEASED: GuardChange = { from: '31.4.0', to: '31.4.1', guards: ['bare-error', 'raw-fetch'] };
const PENDING: GuardChange = { from: '31.4.1', to: undefined, guards: ['native-confirm'] };

describe('the rule', () => {
  test('a template changed and no row: red, naming every guard', () => {
    const page = '| a thing | nothing |\n';
    expect(unstatedGuards(RELEASED, page)).toEqual(['bare-error', 'raw-fetch']);
    const gaps = guardRefreshGaps([RELEASED, PENDING], page);
    expect(gaps.map((gap) => gap.missing)).toEqual([
      ['bare-error', 'raw-fetch'],
      ['native-confirm'],
    ]);
  });

  test('the row names the guards, x g guard and the release: green', () => {
    const page =
      '| **31.4.1** changed `bare-error` and `raw-fetch` | `x g guard <name> --force` per name |\n';
    expect(guardRefreshGaps([RELEASED], page)).toEqual([]);
  });

  test('per guard: a row naming one of two leaves the other red', () => {
    const page = '| **31.4.1**: `x g guard bare-error --force` |\n';
    expect(unstatedGuards(RELEASED, page)).toEqual(['raw-fetch']);
  });

  test('the version must be in the range: an older release`s row does not count', () => {
    const page = '| **31.0.0**: `x g guard bare-error --force`, `x g guard raw-fetch --force` |\n';
    expect(unstatedGuards(RELEASED, page)).toEqual(['bare-error', 'raw-fetch']);
  });

  test('the name and the command must share the row, not merely the page', () => {
    const page =
      '| **31.4.1** changed `bare-error` and `raw-fetch` | nothing |\n| `x g guard` | x |\n';
    expect(unstatedGuards(RELEASED, page)).toEqual(['bare-error', 'raw-fetch']);
  });

  test('a name is matched whole: `raw-fetch-extra` is not `raw-fetch`', () => {
    const page = '| **31.4.1**: `x g guard raw-fetch-extra --force`, `bare-error` |\n';
    expect(unstatedGuards(RELEASED, page)).toEqual(['raw-fetch']);
  });

  test('[Unreleased] accepts any version past the latest tag — the one the bump will cut', () => {
    expect(unstatedGuards(PENDING, '| **31.4.2**: `x g guard native-confirm --force` |')).toEqual(
      [],
    );
    expect(unstatedGuards(PENDING, '| **31.4.1**: `x g guard native-confirm --force` |')).toEqual([
      'native-confirm',
    ]);
  });

  test('versions order numerically', () => {
    expect(compareVersions('31.10.0', '31.9.9')).toBeGreaterThan(0);
    expect(compareVersions('31.4.1', '31.4.1')).toBe(0);
  });
});

describe('the finding', () => {
  test('names the range and the guards, and its fix opens with the command that lists them', () => {
    const finding = guardRefreshFinding({ change: RELEASED, missing: ['raw-fetch'] });
    expect(finding.code).toBe('X_DOC_GUARD_REFRESH_UNSTATED');
    expect(finding.cause).toContain('31.4.0 → 31.4.1: raw-fetch');
    expect(finding.fix).toStartWith(
      'git diff --name-only v31.4.0 v31.4.1 -- packages/cli/src/templates/',
    );
    expect(finding.fix).toContain('bun run changelog-check --json');
  });

  test('for [Unreleased] the diff is against the working tree', () => {
    const finding = guardRefreshFinding({ change: PENDING, missing: ['native-confirm'] });
    expect(finding.cause).toContain('31.4.1 → [Unreleased]');
    expect(finding.fix).toStartWith('git diff --name-only v31.4.1 -- ');
  });
});
