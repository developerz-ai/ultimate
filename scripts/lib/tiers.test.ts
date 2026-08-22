/**
 * The FLOOR half of the tier rule, which did not exist until 2026-08-22: this file's header claimed
 * every package sat "at the lowest tier their real imports allow — checked by this file's own rule",
 * and `boundaries.ts` enforced the CEILING only. Five packages sat above their floor, three of them
 * with a written reason and two — `policy`, `pwa` — with none.
 *
 * The load-bearing test is the last one: over the real tree, every package is at its floor or has a
 * non-blank row. Blank one row and it reds.
 */

import { describe, expect, test } from 'bun:test';
import { collectSourceFiles, packageEdges } from '../boundaries';
import { repoRoot } from './run';
import type { FloorViolation } from './tiers';
import { ALL_PACKAGES, checkFloors, FLOOR_ABOVE, floorFindingFor, floorFor, TIERS } from './tiers';

const edgesOf = (
  graph: Record<string, readonly string[]>,
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(Object.entries(graph).map(([from, to]) => [from, new Set(to)]));

/**
 * Every package sitting exactly at its floor — one import of the tier directly below it — so a
 * fixture only has to state the package that is not. An EMPTY import list would not do it: floor 0
 * makes every package above tier 0 a violation, which is the whole table reporting at once.
 */
const AT_FLOOR: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(TIERS).flatMap(([tier, packages]) => {
    const below = TIERS[Number(tier) - 1]?.[0];
    return packages.map((name) => [name, below === undefined ? [] : [below]] as const);
  }),
);

describe('floorFor', () => {
  test('is one above the highest tier the package reaches', () => {
    expect(floorFor('mail', ['core', 'jobs'])).toBe(4);
    expect(floorFor('mail', ['core'])).toBe(1);
    expect(floorFor('core', [])).toBe(0);
  });

  test('a DECLARED sideways edge sets no floor', () => {
    // `realtime -> query` is same-tier by construction. Counting it would put realtime's floor at 4
    // — a tier it may never sit at — and turn every declared edge into a demand to move a package.
    expect(floorFor('realtime', ['query'])).toBe(0);
    expect(floorFor('cli', ['admin', 'scraping', 'testing'])).toBe(0);
  });

  test('a specifier naming no package in the table is ignored', () => {
    // The ceiling rule already reports it as `unknown-package`; two reports of one condition is the
    // duplication this repo forbids by name.
    expect(floorFor('mail', ['solid-js', 'create-ultimate'])).toBe(0);
  });
});

describe('checkFloors', () => {
  test('a package above its floor with no row is undeclared', () => {
    const violations = checkFloors(edgesOf({ ...AT_FLOOR, mail: ['core'] }), {});
    expect(violations).toEqual([
      { package: 'mail', tier: 4, floor: 1, fault: 'undeclared' } satisfies FloorViolation,
    ]);
  });

  test('a row whose reason is blank is refused as loudly as a missing one', () => {
    const violations = checkFloors(edgesOf({ ...AT_FLOOR, mail: ['core'] }), { mail: '   \n' });
    expect(violations.map((one) => one.fault)).toEqual(['blank-reason']);
  });

  test('a row for a package at its floor is stale', () => {
    const violations = checkFloors(edgesOf({ ...AT_FLOOR, mail: ['jobs'] }), { mail: 'a reason' });
    expect(violations).toEqual([
      { package: 'mail', tier: 4, floor: 4, fault: 'stale-row' } satisfies FloorViolation,
    ]);
  });

  test('a row naming no package in the tier table is stale too', () => {
    const violations = checkFloors(edgesOf(AT_FLOOR), { renderer: 'typo for render' });
    expect(violations.map((one) => one.package)).toEqual(['renderer']);
  });

  test('a package the scan never saw is not judged — an unknown floor is not a floor of 0', () => {
    // The opposite reading shipped for one run of `bun test`: `tierBoundaries` against a fixture
    // directory holding a single file reported 22 packages above a floor derived from no file of
    // theirs. A rule that reports hardest when it can see least is a rule about its own coverage.
    expect(checkFloors(new Map(), FLOOR_ABOVE)).toEqual([]);
    const oneFile = edgesOf({ mail: ['core'] });
    expect(checkFloors(oneFile, FLOOR_ABOVE).map((one) => one.package)).toEqual(['mail']);
  });
});

describe('floorFindingFor', () => {
  test('an undeclared floor names both edits and never "raise the floor"', () => {
    const finding = floorFindingFor({ package: 'pwa', tier: 4, floor: 2, fault: 'undeclared' });
    expect(finding.code).toBe('X_TIER_FLOOR_UNDECLARED');
    expect(finding.at).toBe('scripts/lib/tiers.ts');
    expect(finding.fix).toContain('FLOOR_ABOVE in scripts/lib/tiers.ts');
    expect(finding.fix).toContain('move it to tier 2');
  });

  test('a stale row is told to be deleted', () => {
    const finding = floorFindingFor({ package: 'mail', tier: 4, floor: 4, fault: 'stale-row' });
    expect(finding.code).toBe('X_TIER_FLOOR_STALE');
    // The edit AND the command that confirms it took: a fix line whose repair is a source change
    // still ends in something an agent can run and read (`X_DB_DRIFT`'s shape).
    expect(finding.fix).toBe(
      'delete the "mail" row from FLOOR_ABOVE in scripts/lib/tiers.ts, then bun run boundaries --json',
    );
  });
});

describe('the tier table against the tree it describes', () => {
  test('every package is at its floor or carries a written reason', async () => {
    const edges = packageEdges(await collectSourceFiles(repoRoot()));
    // The parser guard every check here needs: an empty graph would make the assertion vacuous, and
    // that is the failure mode this whole rule exists to end.
    expect(edges.size).toBeGreaterThan(20);
    expect(checkFloors(edges, FLOOR_ABOVE)).toEqual([]);
  });

  test('FLOOR_ABOVE holds exactly the five packages above their floor', () => {
    // Named, so moving one of them is a deliberate edit here rather than a row that quietly rots.
    expect(Object.keys(FLOOR_ABOVE).sort()).toEqual(['policy', 'pwa', 'render', 'scraping', 'ui']);
  });

  test('the package count in this file’s own doc block is the one the table holds', async () => {
    // It read "28 framework packages" while the table held 29 — the drift a comment cannot report.
    const source = await Bun.file(`${import.meta.dir}/tiers.ts`).text();
    const stated = /every one of the (\d+)\s*(?:\n\s*\*)?\s*framework packages/.exec(source);
    expect(
      stated,
      'tiers.ts must state how many framework packages the table holds',
    ).not.toBeNull();
    expect(Number(stated?.[1])).toBe(ALL_PACKAGES.length);
  });
});
