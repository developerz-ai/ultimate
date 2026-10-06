// The enforcement half of `scripts/index-of-order.ts`: this file IS the build error. The real tree
// is asserted NON-VACUOUSLY, because every failure mode this rule has had reads as a clean tree —
// a `Bun.Glob` brace pattern that matched zero files, and a regex that stopped at the `)` inside
// `indexOf(...)` and so matched no assertion at all.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkOrdering,
  orderingSites,
  packageOfTest,
  scanTree,
  TEST_GLOBS,
} from './index-of-order';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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

  test('an explicit index assertion, in each spelling, ON THE SAME EXPRESSION', () => {
    const g = (guard: string): boolean =>
      orderingSites(FILE, wrap(`${guard}\n    expect(up.indexOf('drop x')).toBeLessThan(n);`))[0]
        ?.guarded === true;
    expect(g(`    expect(up.indexOf('drop x')).toBeGreaterThanOrEqual(0);`)).toBe(true);
    expect(g(`    expect(up.indexOf('drop x')).toBeGreaterThan(-1);`)).toBe(true);
    expect(g(`    expect(up.indexOf('drop x')).not.toBe(-1);`)).toBe(true);
    expect(g(`    expect(up.indexOf('drop x')).toBe(3);`)).toBe(true);
  });

  test('a guard on a DIFFERENT expression does not count', () => {
    // The rule that found the STARTTLS defect. `GUARDS.some(body)` never bound to the index, so
    // any unrelated numeric assertion in the same test silenced it — `expect(res.status)
    // .toBe(200)` satisfied `/\.toBe\(\d+\)/`. A false NEGATIVE, and the worst kind: it made
    // the rule quietly weaker than it claimed, and hid a mail client that skipped STARTTLS
    // entirely while its ordering test stayed green.
    expect(guarded(`    expect(res.status).toBe(200);`)).toBe(false);
    expect(guarded(`    expect(rows.length).toBeGreaterThanOrEqual(0);`)).toBe(false);
  });

  test('a split-count is a presence proof, and a stronger one than toContain', () => {
    expect(guarded(`    expect(up.split('drop x').length - 1).toBe(1);`)).toBe(true);
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

  // `@ultimat3/testing`'s typed openers (`unitTest`, `liveTest`, …) are how an APP writes a test.
  // Read as no test at all, the body was empty and a guarded site in `examples/dummy` reported.
  test('a typed opener from @ultimat3/testing is a test body too', () => {
    for (const opener of ['unitTest', 'contractTest', 'liveTest', 'jobTest']) {
      const typed = `${opener}('t', async () => {
  expect(up).toContain('drop x');
  expect(up.indexOf('drop x')).toBeLessThan(n);
});
`;
      expect(orderingSites(FILE, typed).map((site) => site.guarded)).toEqual([true]);
    }
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

  test('a package over its pin lists every unguarded site, never only the first', () => {
    const pins = [{ pkg: 'a', count: 1, reason: 'measured' }];
    const sites = [site(FILE), { ...site('packages/a/src/y.test.ts'), line: 20 }];
    const [finding] = checkOrdering({ sites, pins, scanned: true });
    expect(finding?.cause).toContain(`${FILE}:9, packages/a/src/y.test.ts:20`);
    expect(finding?.fix).toContain('1 of the 2 sites the cause lists');
    // A guarded site is not one of them.
    const guarded = { ...site('packages/a/src/z.test.ts'), guarded: true };
    const [same] = checkOrdering({ sites: [...sites, guarded], pins, scanned: true });
    expect(same?.cause).not.toContain('z.test.ts');
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
    // The `e2e/` tree beside `src/`, and `.tsx` suites, are tests too — and the glob reaches files.
    const e2e = TEST_GLOBS.find((glob) => glob.startsWith('packages/*/e2e/'));
    expect(e2e).toBeDefined();
    expect([...new Bun.Glob(e2e ?? '').scanSync({ cwd: repoRoot() })].length).toBeGreaterThan(0);
    expect(TEST_GLOBS.every((glob) => glob.endsWith('.test.{ts,tsx}'))).toBe(true);

    expect(checkOrdering({ sites, pins: [], scanned: files > 0 })).toEqual([]);
  });
});

// Finding 6, 2026-09-06: the matcher alternation was `toBeLessThan|toBeGreaterThan`, so the
// `OrEqual` pair — the same assertion, one keystroke wider — read as no ordering assertion at all.
// A phantom `-1` passes them identically: `-1 <= anyIndex` and `anyIndex >= -1`.
describe('the OrEqual pair is the same assertion', () => {
  test('toBeLessThanOrEqual: the RECEIVER is at risk, same as toBeLessThan', () => {
    const sites = orderingSites(
      FILE,
      wrap(`    expect(up.indexOf('drop x')).toBeLessThanOrEqual(n);`),
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]?.matcher).toBe('toBeLessThanOrEqual');
    expect(sites[0]?.guarded).toBe(false);
  });

  test('toBeGreaterThanOrEqual: the ARGUMENT is at risk, and the receiver never is', () => {
    const risky = orderingSites(
      FILE,
      wrap(`    expect(n).toBeGreaterThanOrEqual(up.indexOf('add x'));`),
    );
    expect(risky).toHaveLength(1);
    expect(risky[0]?.matcher).toBe('toBeGreaterThanOrEqual');
    expect(risky[0]?.guarded).toBe(false);
    // The safe side stays silent — noise is how a rule gets switched off, which is why the
    // asymmetry is the whole rule. `expect(idx).toBeGreaterThanOrEqual(0)` is itself a GUARD.
    expect(
      orderingSites(FILE, wrap(`    expect(up.indexOf('add x')).toBeGreaterThanOrEqual(n);`)),
    ).toEqual([]);
  });

  test('and a presence guard on the same expression settles it', () => {
    const sites = orderingSites(
      FILE,
      wrap(
        `    expect(up).toContain('drop x');\n    expect(up.indexOf('drop x')).toBeLessThanOrEqual(n);`,
      ),
    );
    expect(sites[0]?.guarded).toBe(true);
  });
});

describe('an index bound to a name first', () => {
  /**
   * The audit's first slip: `const drop = up.indexOf('x'); expect(drop).toBeLessThan(alter)` held
   * no `indexOf` in the operand, so it was no site at all — and it is the spelling a loop over
   * steps writes, `scripts/ci-workflow-shape.test.ts`'s `scaffolds` among them.
   */
  test('is resolved to its initialiser in the same test, and reported', () => {
    const sites = orderingSites(
      FILE,
      wrap(`    const drop = up.indexOf('drop x');\n    expect(drop).toBeLessThan(alter);`),
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]?.guarded).toBe(false);
    expect(sites[0]?.risky).toContain("up.indexOf('drop x')");
  });

  test('a multi-line findIndex initialiser resolves too', () => {
    const body = [
      '    const at = steps.findIndex(',
      "      (step) => step.run.includes('x -- new'),",
      '    );',
      '    expect(n).toBeGreaterThan(at);',
    ].join('\n');
    expect(orderingSites(FILE, wrap(body)).map((site) => site.guarded)).toEqual([false]);
  });

  test('a guard on the NAME or on the needle settles it', () => {
    const bound = `    const drop = up.indexOf('drop x');\n`;
    const guardedBy = (guard: string): boolean =>
      orderingSites(FILE, wrap(`${bound}${guard}\n    expect(drop).toBeLessThan(alter);`))[0]
        ?.guarded === true;
    expect(guardedBy('    expect(drop).toBeGreaterThanOrEqual(0);')).toBe(true);
    expect(guardedBy("    expect(up).toContain('drop x');")).toBe(true);
  });

  test('a name bound to something other than an index is still not a site', () => {
    expect(
      orderingSites(FILE, wrap(`    const n = rows.length;\n    expect(n).toBeLessThan(4);`)),
    ).toEqual([]);
  });

  test('a name bound in a DIFFERENT test does not resolve here', () => {
    const two = `describe('d', () => {
  test('a', () => {
    const drop = up.indexOf('drop x');
  });

  test('b', () => {
    expect(drop).toBeLessThan(alter);
  });
});
`;
    expect(orderingSites(FILE, two)).toEqual([]);
  });
});

describe('a toContain on the WRONG haystack', () => {
  /**
   * The audit's second slip: any `toContain(<the needle>)` in the test counted, whichever string it
   * was asserted on — so `expect(down).toContain('drop x')` guarded `up.indexOf('drop x')`, and the
   * order was checked on a haystack nothing proved held the needle.
   */
  test('does not guard the index on another receiver', () => {
    const body = `    expect(down).toContain('drop x');\n    expect(up.indexOf('drop x')).toBeLessThan(n);`;
    expect(orderingSites(FILE, wrap(body))[0]?.guarded).toBe(false);
  });

  test('nor does a superstring on another receiver', () => {
    const body = `    expect(down).toContain('alter "p" drop x;');\n    expect(up.indexOf('drop x')).toBeLessThan(n);`;
    expect(orderingSites(FILE, wrap(body))[0]?.guarded).toBe(false);
  });

  test('nor a `.not.toContain` on the right one', () => {
    const body = `    expect(up).not.toContain('drop x');\n    expect(up.indexOf('drop x')).toBeLessThan(n);`;
    expect(orderingSites(FILE, wrap(body))[0]?.guarded).toBe(false);
  });

  test('the same receiver, spelled across a line break, still guards', () => {
    const body = `    expect(\n      up,\n    ).toContain('drop x');\n    expect(up.indexOf('drop x')).toBeLessThan(n);`;
    expect(orderingSites(FILE, wrap(body))[0]?.guarded).toBe(true);
  });
});

describe('presence proven by what the test already asserts', () => {
  /**
   * Resolving bound names surfaced six sites in the real tree that a phantom -1 CANNOT pass, each
   * for a reason the rule did not read. Reporting them would be false findings, which this file's
   * header says is how a rule gets switched off — so each proof is read, and each is sound.
   */
  const site = (body: string) => orderingSites(FILE, wrap(body))[0];

  test('X > (an index) proves X >= 0, because every index is >= -1', () => {
    // `packages/db/src/migrate.test.ts`: `expect(index).toBeGreaterThan(table)`, then `index` bounds.
    const body = [
      "    const table = texts.findIndex((t) => t.startsWith('create table'));",
      "    const index = texts.findIndex((t) => t.startsWith('create index'));",
      '    expect(index).toBeGreaterThan(table);',
      "    expect(texts.indexOf('COMMIT')).toBeGreaterThan(index);",
    ].join('\n');
    const commit = orderingSites(FILE, wrap(body)).find((one) => one.risky.startsWith('index'));
    expect(commit?.guarded).toBe(true);
  });

  test('and so does (an index) < X', () => {
    const body = [
      "    const a = up.indexOf('a');",
      "    const b = up.indexOf('b');",
      '    expect(a).toBeLessThan(b);',
      '    expect(n).toBeGreaterThan(b);',
    ].join('\n');
    const later = orderingSites(FILE, wrap(body)).find((one) => one.matcher === 'toBeGreaterThan');
    expect(later?.guarded).toBe(true);
  });

  test('but X >= (an index) proves nothing — -1 >= -1', () => {
    const body = [
      "    const a = up.indexOf('a');",
      "    const b = up.indexOf('b');",
      '    expect(b).toBeGreaterThanOrEqual(a);',
      '    expect(n).toBeGreaterThan(b);',
    ].join('\n');
    const later = orderingSites(FILE, wrap(body)).find((one) => one.matcher === 'toBeGreaterThan');
    expect(later?.guarded).toBe(false);
  });

  test('nor does X > (a value that is not an index)', () => {
    const body = [
      "    const b = up.indexOf('b');",
      '    expect(b).toBeGreaterThan(offset);',
      '    expect(n).toBeGreaterThan(b);',
    ].join('\n');
    expect(
      orderingSites(FILE, wrap(body)).find((one) => one.risky.startsWith('b ='))?.guarded,
    ).toBe(false);
  });

  test('a guard carrying a failure message is the same guard', () => {
    // `packages/cli/src/compile-externals.test.ts`: `expect(at, 'binaryArgs does not …')`.
    const body = [
      '    const at = args.indexOf(specifier);',
      "    expect(at, 'missing').toBeGreaterThanOrEqual(0);",
      "    expect(at).toBeLessThan(args.indexOf('--outfile'));",
    ].join('\n');
    expect(site(body)?.guarded).toBe(true);
    // And `> 0`, the spelling that file uses: stronger than `>= 0`, read as no guard at all.
    expect(site(body.replace('toBeGreaterThanOrEqual(0)', 'toBeGreaterThan(0)'))?.guarded).toBe(
      true,
    );
  });

  test('a value read AT the index proves it, since haystack[-1] is undefined', () => {
    // `packages/testing/src/cdp-e2e-session.test.ts`: `expect(on[pin]?.params).toEqual({ … })`.
    const body = [
      "    const pin = on.findIndex((call) => call.method === 'a');",
      '    expect(on[pin]?.params).toEqual({ headers: 1 });',
      "    expect(pin).toBeLessThan(on.findIndex((call) => call.method === 'b'));",
    ].join('\n');
    expect(site(body)?.guarded).toBe(true);
  });

  test('but not on another haystack, nor against undefined', () => {
    const at = "    const pin = on.findIndex((call) => call.method === 'a');\n";
    const ordered = "\n    expect(pin).toBeLessThan(on.findIndex((call) => call.method === 'b'));";
    expect(site(`${at}    expect(off[pin]).toEqual({ a: 1 });${ordered}`)?.guarded).toBe(false);
    expect(site(`${at}    expect(on[pin]).toBe(undefined);${ordered}`)?.guarded).toBe(false);
    expect(site(`${at}    expect(on[pin]).not.toEqual({ a: 1 });${ordered}`)?.guarded).toBe(false);
  });
});
