// The enforcement half of `scripts/skip-if-cleanup.ts`: this file IS the build error. The real
// tree is asserted NON-VACUOUSLY — a scan that matched no file would report "every one from a
// file-scope hook", which is the answer a correct tree gives, and is exactly how 19 suites leaked
// 36 entities under a green gate.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkCleanup, cleanupFiles } from './skip-if-cleanup';

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
      files: [{ file: 'packages/a/src/x.live.test.ts', cleared: false, line: 0 }],
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
  test('every file that skips and resets does so from a file scope hook', async () => {
    const root = repoRoot();
    const sources = new Map<string, string>();
    let files = 0;
    for (const pattern of ['packages/*/src/**/*.test.ts', 'examples/**/*.test.ts']) {
      for await (const relative of new Bun.Glob(pattern).scan({ cwd: root })) {
        const path = relative.split('\\').join('/');
        files += 1;
        if (path.endsWith('live-registry-cleanup.test.ts')) continue;
        sources.set(path, await Bun.file(`${root}/${path}`).text());
      }
    }
    const scanned = cleanupFiles(sources);
    // Non-vacuity, both directions: the glob found files AND some of them really do hold both
    // shapes. Without the second assertion a glob that stopped matching would make this green by
    // making the rule blind — the failure mode this whole file exists against.
    expect(files).toBeGreaterThan(100);
    expect(scanned.length).toBeGreaterThan(0);

    expect(checkCleanup({ files: scanned, scanned: files > 0 })).toEqual([]);
  });
});
