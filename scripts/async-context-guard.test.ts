// The guard's own proof, in two halves: fixtures that MUST be reported (so the check can fail at
// all) and the real tree, which must be clean. `bun-pin.test.ts` is the precedent for a repo-wide
// rule living beside its script — the gate's `unit` step already collects `scripts/**/*.test.ts`,
// so this needs no step of its own.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  ASYNC_CONTEXT_SEAM,
  type AsyncStorageSite,
  asyncStorageFinding,
  checkAsyncStorage,
  collectGuardedFiles,
} from './async-context-guard';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const one = (source: string, path = 'packages/thing/src/scope.ts'): readonly AsyncStorageSite[] =>
  checkAsyncStorage([{ path, source }]);

const kinds = (sites: readonly AsyncStorageSite[]): readonly string[] =>
  sites.map((site) => `${site.kind}:${site.name}`);

describe('the AsyncLocalStorage guard, on source it must refuse', () => {
  test('reports a module-scope construction and the import that made it expressible', () => {
    const sites = one(`import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();
export const read = (): string | undefined => storage.getStore();
`);
    expect(kinds(sites)).toEqual(['binding:AsyncLocalStorage', 'construction:AsyncLocalStorage']);
    expect(sites[1]?.line).toBe(3);
  });

  test('follows an alias, so renaming the class on the way in hides nothing', () => {
    const sites = one(`import { AsyncLocalStorage as Ambient } from 'node:async_hooks';
const store = new Ambient<number>();
`);
    expect(kinds(sites)).toEqual(['binding:Ambient', 'construction:Ambient']);
  });

  test('follows a namespace import, where the class is reached as a property', () => {
    const sites = one(`import * as hooks from 'async_hooks';
const store = new hooks.AsyncLocalStorage<number>();
`);
    expect(kinds(sites)).toEqual([
      'binding:hooks.AsyncLocalStorage',
      'construction:hooks.AsyncLocalStorage',
    ]);
  });

  test('reports a binding nothing has constructed yet, because the next edit will', () => {
    const sites = one(`import { AsyncLocalStorage } from 'node:async_hooks';
export type Store = AsyncLocalStorage<string>;
`);
    expect(kinds(sites)).toEqual(['binding:AsyncLocalStorage']);
  });

  test('reports a bare construction with no import in the file — a global is still a new', () => {
    expect(kinds(one('const store = new AsyncLocalStorage();'))).toEqual([
      'construction:AsyncLocalStorage',
    ]);
  });

  test('an app is source too — the rule does not stop at the package boundary', () => {
    const sites = one(
      "import { AsyncLocalStorage } from 'node:async_hooks';\nexport const s = new AsyncLocalStorage();",
      'examples/dummy/apps/web/shared/scope.ts',
    );
    expect(kinds(sites)).toEqual(['binding:AsyncLocalStorage', 'construction:AsyncLocalStorage']);
  });

  test('its finding names the file, the line, the edit to make and a command to re-read', () => {
    const site = one('const store = new AsyncLocalStorage();')[0];
    const finding = asyncStorageFinding(site ?? expect.unreachable('no site was reported'));
    expect(finding.code).toBe('X_ASYNC_CONTEXT_UNAVAILABLE');
    expect(finding.at).toBe('packages/thing/src/scope.ts:1');
    // The three halves of the fix line, each asserted: WHERE, WHAT, and the command that re-reads
    // the tree once the edit is made. Prose alone passed the first of these and none of the rest.
    expect(finding.fix).toContain('packages/thing/src/scope.ts:1');
    expect(finding.fix).toContain("asyncContext<T>('what the scope carries')");
    expect(finding.fix).toContain('bun run async-context-guard --json');
  });

  /**
   * The runnable half of the fix line, held to the repo rather than to a string: a `bun run <name>`
   * naming a script `package.json` does not declare is the defect `scripts/test-fix-citations.ts`
   * exists for, and that gate only reads citations beginning `x `.
   */
  test('and the command it names is a script this repo declares', async () => {
    const raw: unknown = JSON.parse(await Bun.file(join(repoRoot(), 'package.json')).text());
    const declared = new Set<string>();
    if (typeof raw === 'object' && raw !== null && 'scripts' in raw) {
      const scripts = raw.scripts;
      if (typeof scripts === 'object' && scripts !== null) {
        for (const name of Object.keys(scripts)) declared.add(name);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect(declared.has('async-context-guard')).toBe(true);
  });
});

describe('the AsyncLocalStorage guard, on source it must leave alone', () => {
  test('reads no defect out of a comment — `telemetry.ts` explains the bug by writing it', () => {
    const sites = one(`// \`new AsyncLocalStorage()\` throws at EVALUATION in a browser bundle.
/** import { AsyncLocalStorage } from 'node:async_hooks'; is what this file must not do. */
export const nothing = 1;
`);
    expect(sites).toEqual([]);
  });

  test('an import of another member of node:async_hooks is not this rule', () => {
    expect(one(`import { AsyncResource } from 'node:async_hooks';`)).toEqual([]);
  });

  test('an unrelated `new` is not a finding', () => {
    expect(one('const seen = new Set<string>();\nconst at = new Date();')).toEqual([]);
  });

  test('the seam itself is the one module allowed to construct one', () => {
    const source = `import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage<string>();
`;
    expect(one(source, ASYNC_CONTEXT_SEAM)).toEqual([]);
    // …and only that path: the exemption is the file, never the shape of what is in it.
    expect(one(source, 'packages/core/src/other.ts')).toHaveLength(2);
  });

  test('a test file is skipped — a test is in nobody`s bundle', () => {
    const source = 'const storage = new AsyncLocalStorage<string>();';
    expect(one(source, 'packages/db/src/transaction.test.ts')).toEqual([]);
  });
});

describe('the whole tree, apps included', () => {
  test('holds exactly one AsyncLocalStorage, and it is the seam', async () => {
    const files = await collectGuardedFiles(repoRoot());
    // Non-vacuity, in three parts: the collector must be reading the packages this rule is about,
    // AND both tracked apps — an app that constructs one is the gap this scan was widened to close,
    // and a green run over a set that never contained an app file would report the same "ok".
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some((file) => file.path === 'packages/db/src/transaction.ts')).toBe(true);
    expect(files.some((file) => file.path.startsWith('examples/dummy/apps/'))).toBe(true);
    expect(files.some((file) => file.path.startsWith('dummy/social-media-clone/apps/'))).toBe(true);
    expect(checkAsyncStorage(files).map(asyncStorageFinding)).toEqual([]);
  }, 60_000);

  /**
   * The mutation, performed rather than described: the seam's REAL source, read off disk and
   * relabelled, is what a seventh module-scope construction would look like. A green run above
   * means the tree is clean only if this one is red.
   */
  test('would report the seam`s own construction from any other path', async () => {
    const files = await collectGuardedFiles(repoRoot());
    const seam =
      files.find((file) => file.path === ASYNC_CONTEXT_SEAM) ??
      expect.unreachable(`${ASYNC_CONTEXT_SEAM} is not in the collected source set`);
    const sites = checkAsyncStorage([{ path: 'packages/core/src/moved.ts', source: seam.source }]);
    expect(kinds(sites)).toEqual(['binding:AsyncLocalStorage', 'construction:AsyncLocalStorage']);
  }, 60_000);
});
