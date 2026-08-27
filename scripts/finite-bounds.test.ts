// The enforcement half of `scripts/finite-bounds.ts`: this file IS the build error. The real tree
// is asserted NON-VACUOUSLY — a scan that read nothing would report "every bound checked", which
// is the answer a correct tree gives, and is how `??`-defaulted options went unchecked in twenty
// packages under a green gate.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './boundaries';
import { collectSourceFiles } from './boundaries';
import {
  checkFiniteBounds,
  finiteBoundFindingFor,
  finiteBoundSites,
  numericConstants,
  scanFiniteBounds,
} from './finite-bounds';
import { FINITE_BOUNDS_PINS } from './lib/finite-bounds-pins';
import { SCREENING_CALLEES, screeningCallPattern } from './lib/finite-screens';
import { repoRoot } from './lib/run';

const UNCHECKED = 'X_FINITE_BOUND_UNCHECKED';
const STALE = 'X_FINITE_BOUND_PIN_STALE';
const UNSCANNED = 'X_FINITE_BOUND_UNSCANNED';

const file = (path: string, source: string): SourceFile => ({ path, source });
const ALL_NUMERIC = new Set(['DEFAULT_SIZE', 'DEFAULT_BYTES']);
const options = (source: string, numeric: ReadonlySet<string> = ALL_NUMERIC): readonly string[] =>
  scanFiniteBounds('packages/a/src/one.ts', source, numeric).map((site) => site.option);

describe('what counts as an unchecked numeric bound', () => {
  test('a property read defaulted to a number is a site', () => {
    expect(options('const n = options.maxBytes ?? 1024;')).toEqual(['maxBytes']);
    expect(options('const n = options.ttl ?? DEFAULT_SIZE;')).toEqual(['ttl']);
    expect(options('const n = def.page.max ?? 30_000;')).toEqual(['max']);
    expect(options('const n = opts.ratio ?? 0.92;')).toEqual(['ratio']);
  });

  test('`?? 0` and `?? 1` are accumulator identities, not configuration', () => {
    // The whole of the noise floor: `map.get(k) ?? 0`, `queued?.seq ?? 0`, `held ?? 1`. Reporting
    // them is how a rule earns the reputation that gets it switched off.
    expect(options('const n = state.seq ?? 0;')).toEqual([]);
    expect(options('const n = state.held ?? 1;')).toEqual([]);
  });

  test('a call or an INDEX on the left is not an option read', () => {
    expect(options('const n = map.get(key) ?? 512;')).toEqual([]);
    expect(options('const n = rows[0].limit ?? 512;')).toEqual([]);
    expect(options('const n = rows[0]?.pending ?? 512;')).toEqual([]);
    expect(options('const n = list.filter(x).length ?? 512;')).toEqual([]);
  });

  test('an optional chain on the OBJECT is an option read, and used to be excluded', () => {
    // This line asserted `[]` until 2026-08-26, and the exclusion was not a judgement — it was
    // the path pattern spelling `\\.` where the code writes `?.`. `auth/src/oauth-cookie.ts`'s
    // handshake TTL is exactly this shape, so a NaN there accepted a year-old sealed handshake
    // under a green ratchet. `rows[0]?.pending` above stays out on the lookbehind's `.`, which is
    // a different character doing different work.
    expect(options('const n = queue?.pending ?? 512;')).toEqual(['pending']);
    expect(options('const n = options?.ttlMs ?? DEFAULT_SIZE;')).toEqual(['ttlMs']);
  });

  test('a SCREAMING default this corpus declares NON-numeric is not a site', () => {
    // `?? DEFAULT_QUEUE`, `?? NO_TENANT`, `?? DEFAULT_RETRY`, `?? CLOUDFLARE_API_URL`,
    // `?? NEVER_ABORTED` all wear the same spelling and none of them is a bound.
    expect(options('const q = handle.queue ?? DEFAULT_QUEUE;')).toEqual([]);
  });

  test('a numeric default is recognised through arithmetic, and one name settles it corpus-wide', () => {
    const numeric = numericConstants([
      file('packages/a/src/c.ts', 'const DEFAULT_BYTES = 1024 * 1024;\nconst NAP = 60_000;'),
      file('packages/a/src/d.ts', "const DEFAULT_QUEUE = 'default';"),
    ]);
    expect(numeric.has('DEFAULT_BYTES')).toBe(true);
    expect(numeric.has('NAP')).toBe(true);
    expect(numeric.has('DEFAULT_QUEUE')).toBe(false);
  });

  test('a name declared numeric in one file and a string in another is NOT numeric', () => {
    const numeric = numericConstants([
      file('packages/a/src/c.ts', 'const DEFAULT_MODE = 3;'),
      file('packages/b/src/d.ts', "const DEFAULT_MODE = 'fast';"),
    ]);
    expect(numeric.has('DEFAULT_MODE')).toBe(false);
  });

  test('a default read out of a TABLE of numbers is a site', () => {
    // `auth/src/verify.ts` shipped `input.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS[input.purpose]`, and
    // the declaration spans lines, so the single-line value capture read `{` and filed the name
    // under "not numeric" — the site was matched by the pattern and then dropped by the filter,
    // which is the shape of a guard whose claim is wider than its reach.
    const source = [
      'const DEFAULT_TTL_MS: Readonly<Record<Purpose, number>> = {',
      "  'email-verify': 24 * 60 * 60 * 1000,",
      "  'password-reset': 60 * 60 * 1000,",
      '};',
      'const ttl = input.ttlMs ?? DEFAULT_TTL_MS[input.purpose];',
    ].join('\n');
    const files = [file('packages/a/src/one.ts', source)];
    expect([...finiteBoundSites(files).values()].flat().map((site) => site.option)).toEqual([
      'ttlMs',
    ]);
  });

  test('a table name is NOT a number, so a bare `?? TABLE` is an object default', () => {
    // Folding table names into the scalar set would report `o.opts ?? DEFAULT_OPTS` — an object
    // default, never a bound. That false report is what gets a rule switched off, so the two sets
    // stay apart.
    const source = [
      'const DEFAULT_OPTS = { retries: 3, delayMs: 50 };',
      'const o = i.opts ?? DEFAULT_OPTS;',
    ].join('\n');
    expect([...finiteBoundSites([file('packages/a/src/one.ts', source)]).values()].flat()).toEqual(
      [],
    );
  });

  test('one non-numeric value disqualifies the whole table', () => {
    const source = ["const LABELS = { a: 'x', b: 2 };", 'const n = i.n ?? LABELS[i.p];'].join('\n');
    expect([...finiteBoundSites([file('packages/a/src/one.ts', source)]).values()].flat()).toEqual(
      [],
    );
  });

  test('a template literal is the CLI writing source, never this file reading its own option', () => {
    // `maskLiterals` blanks a string's contents and preserves every offset, so a scaffold emitting
    // `options.x ?? 30_000` inside a backtick is not read as a bound this module owns.
    expect(options('const t = `const n = options.maxBytes ?? 1024;`;')).toEqual([]);
  });
});

describe('what counts as the repair — and what emphatically does not', () => {
  test('Math.max / Math.min / Math.floor are NOT validators', () => {
    // The single most important thing this rule encodes. All three PROPAGATE NaN, and this repo
    // has relied on all three as guards: `Math.max(1, options.perSecond)` made `AcceptBudget` admit
    // every accept, because `NaN < 1` is false.
    expect(options('const n = Math.max(1, options.perSecond ?? 500);')).toEqual(['perSecond']);
    expect(options('const n = Math.min(options.cap ?? 1024, 99);')).toEqual(['cap']);
    expect(options('const n = Math.floor((options.ttl ?? 30_000) / 3);')).toEqual(['ttl']);
  });

  test('a `??` default is not a validator either — that is the whole mechanism', () => {
    expect(options('const n = options.ms ?? 250;')).toEqual(['ms']);
  });

  test('Number.isFinite naming the option is the repair', () => {
    const source = 'const n = options.maxBytes ?? 1024;\nassert(Number.isFinite(maxBytes), a, b);';
    expect(options(source)).toEqual([]);
  });

  test('the name the option LANDS IN counts, because that is what most asserts read', () => {
    // `packages/jobs/src/limits.ts` is exactly this: `const requested = options.maxTenants ?? D`
    // and then `Number.isFinite(requested)`. Without it the eight in-repo repairs read as absent.
    const source =
      'const requested = options.maxTenants ?? 1000;\nassert(Number.isFinite(requested), a, b);';
    expect(options(source)).toEqual([]);
    expect(options('this.#cap = options.maxBytes ?? 1024;\nNumber.isFinite(this.#cap);')).toEqual(
      [],
    );
  });

  test('a DECLARED screening callee is the repair, wherever the check itself lives', () => {
    expect(options("const n = options.ms ?? 250;\nfiniteOption('S', 'ms', n);")).toEqual([]);
    expect(options("const n = options.ms ?? 250;\nfiniteCount('S', 'ms', n, 1);")).toEqual([]);
  });

  // THE DEFECT, in the direction that cost real work: the recogniser used to read the callee's
  // NAME, so a correct screen called `toMs` reported four sites in a package pinned at 0 and was
  // renamed to satisfy a regex. A row in the table is now what settles it, and the row's name is
  // arbitrary — `toMs` carries nothing this rule could have matched on.
  test('a row in the table is recognised whatever the callee is called', () => {
    const table = [
      { callee: 'toMs', screens: 'a duration, in a package that folded its screen in' },
    ];
    const screened = scanFiniteBounds(
      'packages/a/src/one.ts',
      "const n = toMs(options.pollMs ?? 250, 'worker', 'pollMs');",
      ALL_NUMERIC,
      new Set(),
      screeningCallPattern(table),
    );
    expect(screened).toEqual([]);
    // And the same source against the tree's real table is still a finding — the row is doing the
    // work, not the shape of the call.
    expect(options("const n = toMs(options.pollMs ?? 250, 'worker', 'pollMs');")).toEqual([
      'pollMs',
    ]);
  });

  // THE REGRESSION DIRECTION, and the one that matters: a table read too widely switches the rule
  // off. `assertFiniteCeiling` is invented — it carries `Finite`, which the old pattern accepted
  // outright, and no row declares it. `InfiniteScroll` is real and was accepted for the same
  // reason: a SolidJS component that screens nothing silenced every bound inside its call.
  test('an UNDECLARED callee is not a screen, however it is spelled', () => {
    expect(options("const n = options.ms ?? 250;\nassertFiniteCeiling('ms', n);")).toEqual(['ms']);
    expect(options('const n = InfiniteScroll({ pageSize: options.ms ?? 250 });')).toEqual(['ms']);
  });

  test('a callee that merely CONTAINS a declared name is not that name', () => {
    // `\b` on every bare row: `myfiniteOption(` and `unfinite(` are other functions entirely.
    expect(options("const n = options.ms ?? 250;\nmyfiniteOption('S', 'ms', n);")).toEqual(['ms']);
  });

  test('a repair WRAPPED across lines is recognised — Biome wraps past 100 columns', () => {
    // The first draft compared line by line, so the callee sat on a different line from its
    // arguments and the rule read nine of its own repairs as unrepaired.
    const source = [
      'const n = finiteOption(',
      "  'ChangeBuffer',",
      "  'maxBytesPerQuery',",
      '  options.maxBytesPerQuery ?? DEFAULT_BYTES,',
      ');',
    ].join('\n');
    expect(options(source)).toEqual([]);
  });

  test('a repair naming a DIFFERENT option does not silence this one', () => {
    // `change-buffer.ts` holds four bounds in four consecutive lines. Repairing one must leave the
    // other three reported, or the first fix in a file hides every sibling behind it.
    const source = [
      'this.#capacity = options.capacity ?? 1024;',
      'this.#maxBytes = options.maxBytes ?? DEFAULT_BYTES;',
      "finiteOption('ChangeBuffer', 'capacity', this.#capacity);",
    ].join('\n');
    expect(options(source)).toEqual(['maxBytes']);
  });
});

describe('the ratchet', () => {
  const site = (source: string, path = 'packages/a/src/one.ts'): readonly SourceFile[] => [
    file(path, source),
  ];

  test('a package over its pin is reported, at the first site, with the option quoted', () => {
    const gaps = checkFiniteBounds({
      files: site('const n = options.maxBytes ?? 1024;'),
      pins: {},
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('over');
    expect(gaps[0]?.pkg).toBe('a');
    expect(gaps[0]?.first?.expression).toBe('options.maxBytes ?? 1024');
  });

  test('a package AT its pin is silence, and one below it is stale', () => {
    const files = site('const n = options.maxBytes ?? 1024;');
    const reason = 'measured';
    expect(checkFiniteBounds({ files, pins: { a: { count: 1, reason } } })).toEqual([]);
    const stale = checkFiniteBounds({ files, pins: { a: { count: 4, reason } } });
    expect(stale[0]?.kind).toBe('stale');
    expect(stale[0]?.found).toBe(1);
  });

  test('an empty scan is UNSCANNED, never a clean tree', () => {
    const gaps = checkFiniteBounds({ files: [], pins: {} });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('unscanned');
  });

  test('a test, a fixture and a CLI template hold nothing this rule owns', () => {
    for (const path of [
      'packages/a/src/one.test.ts',
      'packages/a/src/thing-fixture.ts',
      'packages/cli/src/templates/guard.ts',
    ]) {
      expect(finiteBoundSites(site('const n = options.maxBytes ?? 1024;', path)).size, path).toBe(
        0,
      );
    }
  });

  test('every pin carries a positive count and a sentence — a zero row is a rule over nothing', () => {
    // `--unpin` deletes an entry that reaches zero rather than writing `count: 0`, and this is what
    // keeps that true: a row claiming a debt of nothing reads as a rule still in force over a
    // package that has none, and a count with no sentence is a debt nobody can pay.
    for (const [pkg, pin] of Object.entries(FINITE_BOUNDS_PINS)) {
      expect(pin.count, pkg).toBeGreaterThan(0);
      expect(pin.reason.length, pkg).toBeGreaterThan(50);
    }
  });

  test('each kind renders its OWN code, and a prototype key renders none of them', () => {
    const kinds = [
      ['over', UNCHECKED],
      ['stale', STALE],
      ['unscanned', UNSCANNED],
    ] as const;
    for (const [kind, code] of kinds) {
      expect(finiteBoundFindingFor({ kind, pkg: 'a', found: 1, pinned: 0 }).code).toBe(code);
    }
    expect(new Set([UNCHECKED, STALE, UNSCANNED]).size).toBe(3);
  });
});

describe('the screening table', () => {
  // A row nothing declares is the staleness `X_TIER_FLOOR_STALE` refuses for `FLOOR_ABOVE`: it
  // reads as a rule still in force over a helper that was deleted or renamed, and it silently
  // widens what counts as a repair. Asked of the tree rather than of a second list.
  test('every declared screen is a function this corpus declares', async () => {
    const files = await collectSourceFiles(repoRoot());
    const declared = new Set<string>();
    for (const one of files) {
      for (const match of one.source.matchAll(
        /(?:function\s+([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=])/g,
      )) {
        declared.add((match[1] ?? match[2]) as string);
      }
    }
    expect(declared.size, 'the declaration scan read something').toBeGreaterThan(100);
    for (const { callee } of SCREENING_CALLEES) {
      // `Number.*` is the language's, not this tree's — the three irreducible screens.
      if (callee.startsWith('Number.')) continue;
      expect(declared.has(callee), `${callee} is declared in packages/*/src`).toBe(true);
    }
  });

  test('every row carries a sentence, and no callee is listed twice', () => {
    const seen = new Set<string>();
    for (const { callee, screens } of SCREENING_CALLEES) {
      expect(screens.length, callee).toBeGreaterThan(40);
      expect(seen.has(callee), `${callee} is listed once`).toBe(false);
      seen.add(callee);
    }
  });

  test('the pattern is BUILT from the table, so a row can never be unreachable', () => {
    for (const { callee } of SCREENING_CALLEES) {
      expect(screeningCallPattern(SCREENING_CALLEES).test(`${callee}(x)`), callee).toBe(true);
    }
  });

  // A PROPERTY of something is not the declared callee, and `\b` cannot say so: `.` is a word
  // boundary, so a bare row matched `other.finiteOption(` and a dotted row — carrying no left
  // guard at all — matched `OtherNumber.isFinite(`. Both are screens this table never declared,
  // and `finite-bounds.ts` suppresses a finding wherever the pattern hits, so each phantom match
  // is one numeric bound that stops being checked with nothing to say it stopped. Reported by
  // review on #381; these two are the cases, one per row shape.
  test('a callee reached through a property is not the declared callee', () => {
    for (const source of ['other.finiteOption(x)', 'OtherNumber.isFinite(x)']) {
      expect(screeningCallPattern(SCREENING_CALLEES).test(source), source).toBe(false);
    }
  });

  // The other side of the same guard, and it has to be asserted separately: a rule that answers
  // `false` to everything would pass the test above.
  test('a name the declared callee is only a PREFIX of is not the declared callee', () => {
    for (const source of ['finiteOptionish(x)', 'InfiniteScroll(x)', 'myfinite(x)']) {
      expect(screeningCallPattern(SCREENING_CALLEES).test(source), source).toBe(false);
    }
    expect(screeningCallPattern(SCREENING_CALLEES).test('finiteOption(x)')).toBe(true);
  });
});

describe('the real tree', () => {
  test('every tier-0 and tier-1 package checks every numeric option it defaults', async () => {
    // Named individually rather than counted: the total moving is what a future edit is allowed to
    // do, and one of THESE regressing is what it is not.
    //
    // Every tier, 0 through 5: the sweep has landed all five slices. A name may only ever be
    // ADDED to this list — taking one out is the regression the test exists to catch — and a
    // package joins it in the same commit that lowers its row in `finite-bounds-pins.ts`, because
    // `X_FINITE_BOUND_PIN_STALE` fires the moment a repair lands and leaves a pin behind.
    const sites = finiteBoundSites(await collectSourceFiles(repoRoot()));
    // NON-VACUITY: a scanner that found nothing at all would satisfy every assertion below, and
    // this half used to be `total > 10` — a threshold calibrated at 129 sites, which the sweep
    // then walked straight through. A count is the wrong instrument once the count is meant to
    // approach zero: it fails when the tree gets BETTER, and the repair is to keep lowering a
    // magic number until it reaches 0 and stops proving anything. So the proof is the PINS
    // instead. Every pinned package must still report exactly what it is pinned at — those sites
    // are audited and deliberately unrepaired, so they are the one thing a working scanner is
    // guaranteed to find, and a broken one reports 0 for them.
    for (const [pkg, pin] of Object.entries(FINITE_BOUNDS_PINS)) {
      expect(sites.get(pkg) ?? [], `${pkg} still reports its pinned sites`).toHaveLength(pin.count);
    }
    expect(Object.keys(FINITE_BOUNDS_PINS).length).toBeGreaterThan(0);
    const swept = [
      // tier 0–1, swept in the first slice
      'core',
      'schema',
      'db',
      'cache',
      'storage',
      'time',
      'money',
      'i18n',
      'seo',
      // tier 2–3
      'entity',
      'policy',
      'http',
      'auth',
      'action',
      'query',
      'jobs',
      'realtime',
      // tier 4, swept in this one. `ui` is NOT here and must not be added while it holds a pin:
      // three of its props are audited and deliberately unscreened, and the pin carries the reason.
      'ai',
      'render',
      'pwa',
      'mail',
      'manifest',
      'mcp',
      'notify',
      // tier 5, swept in this one. `admin` is NOT here and must not be added while it holds a
      // pin: `logo.width` is audited and deliberately unscreened, and the pin carries the reason.
      'scraping',
      'cli',
      'testing',
    ];
    for (const pkg of swept) {
      expect(sites.get(pkg) ?? [], `${pkg} has no unchecked numeric option`).toEqual([]);
    }
  });

  test('every site the rule reports is a real `??` over a property read', async () => {
    // The false-positive story, asserted rather than promised: no reported expression may contain a
    // call, an index or an optional chain on its left, and none may default to 0 or 1.
    const sites = finiteBoundSites(await collectSourceFiles(repoRoot()));
    for (const list of sites.values()) {
      for (const one of list) {
        const [left = '', right = ''] = one.expression.split('??');
        expect(left, one.path).not.toInclude('(');
        expect(left, one.path).not.toInclude('[');
        expect(left, one.path).not.toInclude('?.');
        expect(['0', '1'], one.path).not.toContain(right.trim());
      }
    }
  });
});
