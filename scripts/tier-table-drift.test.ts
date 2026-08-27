/**
 * Two prose copies of the tier table; `scripts/lib/tiers.ts` is the executable one. Both prose
 * copies say in their own words that they must agree with it — and until this file, nothing
 * checked, so they did not: `flags` was added to tier 1 in the executable table and to neither
 * prose one.
 *
 * That is the failure mode axiom 3 names. CLAUDE.md is the first thing an agent reads and the last
 * thing anyone re-reads, so a stale row there is a wrong tier assignment for every package added
 * afterwards — and the boundary checker enforces the OTHER table, so the mistake surfaces as an
 * inexplicable build error rather than as the doc being wrong.
 */

import { describe, expect, test } from 'bun:test';
import { TIERS } from './lib/tiers';

const CLAUDE_MD = `${import.meta.dir}/../CLAUDE.md`;
const PACKAGE_MAP = `${import.meta.dir}/../docs/architecture/01-package-map.md`;

/** `| 1 | \`i18n\`, \`money\` |` -> `['1', ['i18n', 'money']]`. */
function parseProseTiers(markdown: string): Map<string, readonly string[]> {
  const rows = new Map<string, readonly string[]>();
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|\s*(`.+`)\s*\|$/.exec(line.trim());
    if (match === null) continue;
    const [, tier, cell] = match;
    if (tier === undefined || cell === undefined) continue;
    rows.set(
      tier,
      [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
    );
  }
  return rows;
}

describe('the tier table in CLAUDE.md matches the executable one', () => {
  test('every tier lists exactly the packages `TIERS` lists, in the same order', async () => {
    const prose = parseProseTiers(await Bun.file(CLAUDE_MD).text());
    // A parser that found nothing would make every assertion below vacuously true — the failure
    // mode this whole file exists to prevent, reintroduced one level up.
    expect(prose.size).toBe(Object.keys(TIERS).length);

    for (const [tier, packages] of Object.entries(TIERS)) {
      expect(prose.get(tier), `CLAUDE.md has no row for tier ${tier}`).toEqual([...packages]);
    }
  });

  test('every package directory appears in exactly one tier', async () => {
    // The other direction: a package can also be added to `packages/` and to neither table, which
    // reads as "no tier" and imports nothing until someone notices.
    // why: Bun has no readdir — Bun.Glob matches paths and never reports a Dirent, so nothing
    // native answers "which entries here are directories".
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(`${import.meta.dir}/../packages`, { withFileTypes: true });
    const onDisk = dirs
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Not a framework package: unscoped, and the one thing allowed to depend on the CLI.
      .filter((name) => name !== 'create-ultimate');

    const tiered = new Set(Object.values(TIERS).flat());
    expect([...onDisk].filter((name) => !tiered.has(name)).sort()).toEqual([]);
  });
});

/** `tier 1  i18n, money   (may import tier 0)` -> `['1', ['i18n', 'money']]`. */
function parseFencedTiers(markdown: string): Map<string, readonly string[]> {
  const rows = new Map<string, readonly string[]>();
  for (const line of markdown.split('\n')) {
    // The trailing `(may import …)` is prose about the rule, not a member of the tier.
    const match = /^tier\s+(\d+)\s+([^(]+?)\s*(?:\(.*\))?$/.exec(line.trim());
    if (match === null) continue;
    const [, tier, cell] = match;
    if (tier === undefined || cell === undefined) continue;
    rows.set(
      tier,
      cell.split(',').map((name) => name.trim()),
    );
  }
  return rows;
}

describe('the tier block in docs/architecture/01-package-map.md matches the executable one', () => {
  test('every tier lists exactly the packages `TIERS` lists, in the same order', async () => {
    const prose = parseFencedTiers(await Bun.file(PACKAGE_MAP).text());
    // Same guard as the CLAUDE.md parser: a parser that found nothing makes every assertion below
    // vacuously true, which is this file's own failure mode reintroduced one level up.
    expect(prose.size).toBe(Object.keys(TIERS).length);

    for (const [tier, packages] of Object.entries(TIERS)) {
      expect(prose.get(tier), `01-package-map.md has no row for tier ${tier}`).toEqual([
        ...packages,
      ]);
    }
  });

  test('the package count in the lede matches the executable table', async () => {
    // The count is load-bearing prose: it is the first sentence of the file, and it drifted for
    // the same reason the rows did — `flags` shipped and nobody re-counted.
    const text = await Bun.file(PACKAGE_MAP).text();
    const match = /^(\d+) packages, (\d+) tiers\./m.exec(text);
    expect(match, '01-package-map.md must open with "<n> packages, <n> tiers."').not.toBeNull();

    const tiered = Object.values(TIERS).flat();
    expect(Number(match?.[1])).toBe(tiered.length);
    expect(Number(match?.[2])).toBe(Object.keys(TIERS).length);
  });
});
