// The enforcement half of `scripts/index-of-order.ts`: this file IS the build error. The real tree
// is asserted NON-VACUOUSLY, because every failure mode this rule has had reads as a clean tree —
// a `Bun.Glob` brace pattern that matched zero files, and a regex that stopped at the `)` inside
// `indexOf(...)` and so matched no assertion at all.

import { describe, expect, test } from 'bun:test';
import { checkOrdering, orderingSites, packageOfTest, scanTree } from './index-of-order';
import { repoRoot } from './lib/run';

const UNGUARDED = 'X_INDEX_ORDER_UNGUARDED';
const STALE = 'X_INDEX_ORDER_PIN_STALE';
const UNSCANNED = 'X_INDEX_ORDER_UNSCANNED';

const FILE = 'packages/a/src/x.test.ts';
const wrap = (body: string): string =>
  `describe('d', () => {\n  test('t', () => {\n${body}\n  });\n});\n`;

describe('which operand a phantom -1 passes', () => {
  test('toBeLessThan: the RECEIVER is at risk', () => {
    const sites = orderingSites(FILE, wrap(`    expect(up.indexOf('drop x')).toBeLessThan(n);`));
    expect(sites).toHaveLength(1);
    expect(sites[0]?.matcher).toBe('toBeLessThan');
    expect(sites[0]?.guarded).toBe(false);
  });

  test('toBeGreaterThan: the ARGUMENT is at risk, and the receiver is not', () => {
    // The asymmetry is the whole rule. `-1` as the receiver of `toBeGreaterThan` FAILS, loudly,
    // so reporting that side would be noise — and noise is how a rule gets switched off.
    const risky = orderingSites(FILE, wrap(`    expect(n).toBeGreaterThan(up.indexOf('add x'));`));
    expect(risky).toHaveLength(1);
    expect(risky[0]?.risky).toContain("indexOf('add x')");

    const safe = orderingSites(FILE, wrap(`    expect(up.indexOf('add x')).toBeGreaterThan(n);`));
    expect(safe).toEqual([]);
  });

  test('a comparison with no indexOf on the risky side is not a site at all', () => {
    expect(orderingSites(FILE, wrap(`    expect(a).toBeLessThan(b);`))).toEqual([]);
  });
});

describe('what counts as a guard', () => {
  const guarded = (guard: string): boolean =>
    orderingSites(FILE, wrap(`${guard}\n    expect(up.indexOf('drop x')).toBeLessThan(n);`))[0]
      ?.guarded === true;

  test('toContain of the same needle', () => {
    expect(guarded(`    expect(up).toContain('drop x');`)).toBe(true);
  });

  test('toContain of a SUPERSTRING — the spelling this tree reaches for most', () => {
    // `check-ddl.test.ts` asserts the whole statement and then orders on a fragment of it, which
    // is strictly stronger. Comparing the two literally reported it unguarded — this rule's own
    // false positive, caught by running it against a site a manual sweep had already cleared.
    expect(guarded(`    expect(up).toContain('alter table "p" drop x now;');`)).toBe(true);
  });

  test('an explicit index assertion, in each spelling', () => {
    expect(guarded(`    expect(i).toBeGreaterThanOrEqual(0);`)).toBe(true);
    expect(guarded(`    expect(i).toBeGreaterThan(-1);`)).toBe(true);
    expect(guarded(`    expect(i).not.toBe(-1);`)).toBe(true);
    expect(guarded(`    expect(i).toBe(3);`)).toBe(true);
  });

  test('a matcher argument on its own line ends with a comma, and still resolves', () => {
    // Both blind spots below were found by an agent RUNNING this rule over sites a manual sweep
    // had already cleared, not by reading it. Each was a false positive, which this rule's own
    // header says is how a rule gets switched off.
    const wrapped = `describe('d', () => {
  test('t', () => {
    expect(texts).toContain('drop index "x"');
    expect(texts.indexOf('drop table "y"')).toBeGreaterThan(
      texts.indexOf('drop index "x"'),
    );
  });
});
`;
    const sites = orderingSites(FILE, wrapped);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.guarded).toBe(true);
  });

  test('value-at-index proves presence as totally as index-at-value', () => {
    expect(guarded(`    expect(names[0]).toBe('drop x');`)).toBe(true);
  });

  test('a toContain of an UNRELATED string does not guard it', () => {
    expect(guarded(`    expect(up).toContain('something else');`)).toBe(false);
  });

  test('a guard in a DIFFERENT test does not reach this one', () => {
    const two = `describe('d', () => {
  test('a', () => {
    expect(up).toContain('drop x');
  });

  test('b', () => {
    expect(up.indexOf('drop x')).toBeLessThan(n);
  });
});
`;
    const sites = orderingSites(FILE, two);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.guarded).toBe(false);
  });
});

describe('the ratchet', () => {
  const site = (file: string) => ({
    file,
    line: 9,
    matcher: 'toBeLessThan' as const,
    risky: "up.indexOf('x')",
    guarded: false,
  });

  test('an unguarded site above its pin is a finding that names the operand at risk', () => {
    const findings = checkOrdering({ sites: [site(FILE)], pins: [], scanned: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNGUARDED);
    expect(findings[0]?.at).toBe(`${FILE}:9`);
    expect(findings[0]?.cause).toContain('less-than RECEIVER');
  });

  test('a pin absorbs it, and a count that DROPS is stale', () => {
    const pins = [{ pkg: 'a', count: 1, reason: 'measured' }];
    expect(checkOrdering({ sites: [site(FILE)], pins, scanned: true })).toEqual([]);
    const stale = checkOrdering({ sites: [], pins, scanned: true });
    expect(stale[0]?.code).toBe(STALE);
  });

  test('a rule that read nothing says so, rather than reporting a clean tree', () => {
    expect(checkOrdering({ sites: [], pins: [], scanned: false })[0]?.code).toBe(UNSCANNED);
  });

  test('a package name is read from the path, and scripts/ is its own bucket', () => {
    expect(packageOfTest('packages/db/src/x.test.ts')).toBe('db');
    expect(packageOfTest('scripts/x.test.ts')).toBe('scripts');
  });
});

describe('the real tree', () => {
  test('no unguarded ordering assertion, and the scan really reached the files', async () => {
    const { sites, files } = await scanTree(repoRoot());
    // Non-vacuity in both directions: the globs found files AND the scanner really found ordering
    // assertions in them. Either number going to zero would make this suite green by making the
    // rule blind, which is how both of its earlier drafts failed.
    expect(files).toBeGreaterThan(1000);
    expect(sites.length).toBeGreaterThan(20);

    const { INDEX_OF_ORDER_PINS } = await import('./lib/index-of-order-pins');
    expect(checkOrdering({ sites, pins: INDEX_OF_ORDER_PINS, scanned: files > 0 })).toEqual([]);
  });
});
