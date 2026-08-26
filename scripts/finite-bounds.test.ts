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

  test('a call, an index or an optional chain on the left is not an option read', () => {
    expect(options('const n = map.get(key) ?? 512;')).toEqual([]);
    expect(options('const n = rows[0].limit ?? 512;')).toEqual([]);
    expect(options('const n = queue?.pending ?? 512;')).toEqual([]);
    expect(options('const n = list.filter(x).length ?? 512;')).toEqual([]);
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

  test('a callee carrying `Finite` is the repair too, wherever the check itself lives', () => {
    expect(options("const n = options.ms ?? 250;\nfiniteOption('S', 'ms', n);")).toEqual([]);
    expect(options("const n = options.ms ?? 250;\nassertFiniteCeiling('ms', n);")).toEqual([]);
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

describe('the real tree', () => {
  test('every tier-0 and tier-1 package checks every numeric option it defaults', async () => {
    // Named individually rather than counted: the total moving is what a future edit is allowed to
    // do, and one of THESE regressing is what it is not.
    //
    // This list is the tier-0/1 band, because that is the slice of the 17.0.0 sweep this tree
    // holds. The later slices repair the tiers above and each ADDS its own names here as it lands —
    // `jobs`, `realtime` and `query` next, which were swept by hand on 2026-08-26 and are pinned in
    // `finite-bounds-pins.ts` until that slice merges. A name may only ever be ADDED to this list:
    // taking one out is the regression the test exists to catch.
    const sites = finiteBoundSites(await collectSourceFiles(repoRoot()));
    const total = [...sites.values()].reduce((sum, list) => sum + list.length, 0);
    // Non-vacuity: a scan that found nothing at all would satisfy every assertion below.
    expect(total).toBeGreaterThan(10);
    const swept = ['core', 'schema', 'db', 'cache', 'storage', 'time', 'money', 'i18n', 'seo'];
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
