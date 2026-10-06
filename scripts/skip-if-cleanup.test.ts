// The enforcement half of `scripts/skip-if-cleanup.ts`: this file IS the build error. The real
// tree is asserted NON-VACUOUSLY — a scan that matched no file would report "every one from a
// file-scope hook", which is the answer a correct tree gives, and is exactly how 19 suites leaked
// 36 entities under a green gate.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkCleanup, cleanupFiles, readTestSources } from './skip-if-cleanup';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const UNREACHED = 'X_SKIP_CLEANUP_UNREACHED';
const UNSCANNED = 'X_SKIP_CLEANUP_UNSCANNED';

const one = (source: string): ReadonlyMap<string, string> =>
  new Map([['packages/a/src/x.live.test.ts', source]]);

/** A file-scope hook that really clears — the shape all 19 entity suites now hold. */
const CLEARED = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {});
afterAll(() => {
  clearRegistry();
});
`;

describe('what survives a skipped suite', () => {
  test('a reset from a file-scope hook is the passing shape', () => {
    expect(cleanupFiles(one(CLEARED))[0]?.cleared).toBe(true);
  });

  test('a reset inside the skipped block does not survive it', () => {
    // Bun evaluates the module body of a skipped file, so the registration happens; it does not
    // run a hook inside `describe.skipIf(true)`, so this teardown never fires.
    const nested = `import { afterAll, describe } from 'bun:test';
describe.skipIf(true)('live', () => {
  afterAll(() => {
    clearRegistry();
  });
});
`;
    expect(cleanupFiles(one(nested))[0]?.cleared).toBe(false);
  });

  test('a file-scope hook that returns early on the skip condition leaks identically', () => {
    // The second route, and the reason the rule is not "is the call inside a describe". One of
    // the 19 was exactly this shape, and a nesting-only rule reads straight past it.
    const bailed = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {});
afterAll(() => {
  if (!ready) return;
  clearRegistry();
});
`;
    expect(cleanupFiles(one(bailed))[0]?.cleared).toBe(false);
  });

  test('a BRACED early return leaks exactly as the one-liner does', () => {
    const braced = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {});
afterAll(() => {
  if (!ready) {
    return;
  }
  clearRegistry();
});
`;
    expect(cleanupFiles(one(braced))[0]?.cleared).toBe(false);
  });

  test('a file that skips but resets nothing is not this rule’s business', () => {
    const noReset = `import { describe } from 'bun:test';
describe.skipIf(true)('live', () => {});
`;
    expect(cleanupFiles(one(noReset))).toEqual([]);
  });

  test('a file that resets but never skips is not either', () => {
    const noSkip = `import { afterAll } from 'bun:test';
afterAll(() => {
  clearRegistry();
});
`;
    expect(cleanupFiles(one(noSkip))).toEqual([]);
  });

  test('clearTimeout is a builtin, not a registry — never reported', () => {
    // The first draft matched it and called a `realtime` live test a violation, on a file whose
    // only `clear…(` clears a timer handle.
    const timer = `import { describe } from 'bun:test';
describe.skipIf(true)('live', () => {});
function stop(timer: number) {
  clearTimeout(timer);
}
`;
    expect(cleanupFiles(one(timer))).toEqual([]);
  });
});

describe('the finding', () => {
  test('names the file and the two shapes that leak', () => {
    const findings = checkCleanup({
      files: [{ file: 'packages/a/src/x.live.test.ts', cleared: false, line: 0, unreached: [] }],
      scanned: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNREACHED);
    expect(findings[0]?.cause).toContain('module body');
    expect(findings[0]?.fix).toContain('guard nothing on the skip condition');
  });

  test('a rule that read nothing says so, rather than reporting a clean tree', () => {
    const findings = checkCleanup({ files: [], scanned: false });
    expect(findings[0]?.code).toBe(UNSCANNED);
  });
});

describe('the real tree', () => {
  // `readTestSources`, not a second copy of the glob list: a test with its own loop diverges from
  // the runner, which is exactly what happened to `index-of-order` — its test kept scanning the
  // file the runner had learned to skip, so the rule was green and its own suite red.
  test('every file that skips and resets does so from a file scope hook', async () => {
    const { sources, files } = await readTestSources(repoRoot());
    const scanned = cleanupFiles(sources);
    // Non-vacuity, both directions: the glob found files AND some of them really do hold both
    // shapes. Without the second assertion a glob that stopped matching would make this green by
    // making the rule blind — the failure mode this whole file exists against.
    expect(files).toBeGreaterThan(100);
    expect(scanned.length).toBeGreaterThan(0);
    // The `e2e/` tree beside `src/` is tests too — `scripts/lib/corpus.ts`'s `tests` scope reads it.
    expect([...sources.keys()].some((path) => /^packages\/[^/]+\/e2e\//.test(path))).toBe(true);

    expect(checkCleanup({ files: scanned, scanned: files > 0 })).toEqual([]);
  });
});

// Finding 2, 2026-09-06. Four holes, each measured against the rule's own scan function:
// `cleared` was a file-level BOOLEAN, so one unrelated file-scope reset laundered every reset
// parked in a skipped block; a braced ONE-LINE early return was invisible; `registry.clear()` was
// not a reset at all; and `afterAll(clearRegistry)` — the hook-REFERENCE form — was reported
// though the reset runs.
describe('the reset is tracked per callee, never as one flag for the file', () => {
  test('a file-scope hook clearing a DIFFERENT registry does not launder the parked one', () => {
    const laundered = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {
  afterAll(() => {
    clearRegistry();
  });
});
afterAll(() => {
  resetClock();
});
`;
    const scanned = cleanupFiles(one(laundered));
    expect(scanned[0]?.cleared).toBe(false);
    expect(scanned[0]?.unreached).toEqual(['clearRegistry']);
  });

  test('and the finding names the reset that never runs', () => {
    const findings = checkCleanup({
      files: [
        {
          file: 'packages/a/src/x.live.test.ts',
          cleared: false,
          line: 0,
          unreached: ['clearRegistry'],
        },
      ],
      scanned: true,
    });
    expect(findings[0]?.cause).toContain('clearRegistry');
  });

  // The VERB was not captured, so every method reset was tracked as `<receiver>.clear` — and
  // `entityRegistry.reset()` therefore wore `entityRegistry.clear()`'s green tick. Two distinct
  // resets on one receiver collapsing into one tracked name is the launder the per-callee rewrite
  // closed, re-opened one line down.
  test('two verbs on ONE receiver are two resets, not one', () => {
    const laundered = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {
  entityRegistry.reset();
});
afterAll(() => {
  entityRegistry.clear();
});
`;
    const scanned = cleanupFiles(one(laundered));
    expect(scanned[0]?.cleared).toBe(false);
    // The name the finding prints is the call the file actually contains, so the fix is applicable.
    expect(scanned[0]?.unreached).toEqual(['entityRegistry.reset']);
  });

  test('and the same verb from a file-scope hook is still the passing shape', () => {
    const cleared = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {
  entityRegistry.reset();
});
afterAll(() => {
  entityRegistry.reset();
});
`;
    expect(cleanupFiles(one(cleared))[0]?.cleared).toBe(true);
  });
});

// An `if` opening an ordinary BLOCK is not a bail: `(?:return\b|$)` let `if (!seeded) {` match, and
// `bailed` is cleared by nothing until the next file-scope hook — so every reset under it went
// uncredited. `BRACED_RETURN` still reads the wrapped `return` on the following line.
describe('an early return is a RETURN, not any braced if', () => {
  test('an ordinary if-block inside a file-scope hook does not poison the rest of it', () => {
    const source = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {});
afterAll(() => {
  if (!seeded) {
    seed();
  }
  clearRegistry();
});
`;
    expect(cleanupFiles(one(source))[0]?.cleared).toBe(true);
  });

  test('while a real braced early return still bails', () => {
    const source = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {});
afterAll(() => {
  if (!ready) {
    return;
  }
  clearRegistry();
});
`;
    expect(cleanupFiles(one(source))[0]?.cleared).toBe(false);
  });
});

describe('the shapes the scan could not read', () => {
  const skip = `import { afterAll, describe } from 'bun:test';
const ready = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!ready)('live', () => {});
`;

  test('a BRACED one-line early return leaks exactly as the two-line one does', () => {
    const source = `${skip}afterAll(() => {
  if (!ready) { return; }
  clearRegistry();
});
`;
    expect(cleanupFiles(one(source))[0]?.cleared).toBe(false);
  });

  test('registry.clear() is a reset — the rule demanded clear[A-Z]', () => {
    const source = `${skip}describe.skipIf(!ready)('more', () => {
  afterAll(() => {
    entityRegistry.clear();
  });
});
`;
    const scanned = cleanupFiles(one(source));
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.cleared).toBe(false);
  });

  test('and a module-scope registry.clear() from a FILE-scope hook is the passing shape', () => {
    const source = `${skip}afterAll(() => {
  entityRegistry.clear();
});
`;
    expect(cleanupFiles(one(source))[0]?.cleared).toBe(true);
  });

  test('a local Map’s .clear() is a builtin, not a registry', () => {
    const source = `${skip}describe.skipIf(!ready)('more', () => {
  const seen = new Map<string, number>();
  afterAll(() => {
    seen.clear();
  });
});
`;
    expect(cleanupFiles(one(source))).toEqual([]);
  });

  test('afterAll(clearRegistry) — the hook-REFERENCE form — runs, and was reported', () => {
    const source = `${skip}afterAll(clearRegistry);
`;
    expect(cleanupFiles(one(source))[0]?.cleared).toBe(true);
  });
});

describe('the skip spelled as an alias, not a `.skipIf(`', () => {
  /**
   * The repo's commonest spelling — 17 files `As of 2026-10` — and the rule only triggered on
   * `.skipIf(`, so every one of them was outside it. Bun skips a `describe.skip` block's hooks
   * exactly as it skips a `describe.skipIf(true)` block's.
   */
  test('`url === undefined ? describe.skip : describe` is a skip, and the parked reset leaks', () => {
    const aliased = `import { afterAll, describe } from 'bun:test';
const url = process.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
describeLive('live', () => {
  afterAll(() => {
    clearRegistry();
  });
});
`;
    expect(cleanupFiles(one(aliased))[0]?.cleared).toBe(false);
  });

  test('the same alias with the reset at file scope is the passing shape', () => {
    const fixed = `import { afterAll, describe } from 'bun:test';
const describeLive = url ? describe : describe.skip;
describeLive('live', () => {});
afterAll(() => {
  clearRegistry();
});
`;
    expect(cleanupFiles(one(fixed))[0]?.cleared).toBe(true);
  });

  test('a test.skip alias is the same skip', () => {
    const aliased = `const liveTest = ready ? test : test.skip;
describe('live', () => {
  afterAll(() => {
    resetLimiter();
  });
});
`;
    expect(cleanupFiles(one(aliased))[0]?.unreached).toEqual(['resetLimiter']);
  });
});

describe('a reset of something only a hook creates', () => {
  /**
   * `let store: Store;` assigned in `beforeAll` is `undefined` in a skipped file — the module body
   * creates nothing, so `store.reset()` clears rows the live suite made, not a registry the import
   * left behind. Surfaced by the alias spelling in two rate-limit suites; reporting them would be a
   * false finding, and a false finding is how a rule gets switched off.
   */
  test('`let store: Store;` + `store.reset()` in a bailed hook is not a registry', () => {
    const hookOwned = `const describeLive = url === undefined ? describe.skip : describe;
let store: PostgresRateLimitStore;
beforeAll(async () => {
  if (url === undefined) return;
  store = postgresRateLimitStore({ executor });
});
beforeEach(async () => {
  if (url === undefined) return;
  await store.reset();
});
describeLive('live', () => {});
`;
    expect(cleanupFiles(one(hookOwned))).toEqual([]);
  });

  test('the same binding assigned in the module body IS import-time state', () => {
    const imported = `const describeLive = url === undefined ? describe.skip : describe;
let registry: Registry;
registry = createRegistry();
describeLive('live', () => {
  afterAll(() => {
    registry.reset();
  });
});
`;
    expect(cleanupFiles(one(imported))[0]?.unreached).toEqual(['registry.reset']);
  });
});

describe('a binding assigned in the module body is never hook-owned, whatever its indent', () => {
  test('an assignment inside a top-level `if` runs at import, so its reset is a registry', () => {
    const conditional = `const describeLive = url === undefined ? describe.skip : describe;
let registry: Registry;
if (process.env['SEED'] !== undefined) {
  registry = createRegistry();
}
describeLive('live', () => {
  afterAll(() => {
    registry.reset();
  });
});
`;
    expect(cleanupFiles(one(conditional))[0]?.unreached).toEqual(['registry.reset']);
  });
});
