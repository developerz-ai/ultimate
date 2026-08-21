// The guard's own proof, in two halves: fixtures that MUST be reported (so the check can fail at
// all) and the real tree, which must be clean. `bun-pin.test.ts` is the precedent for a repo-wide
// rule living beside its script — the gate's `unit` step already collects `scripts/**/*.test.ts`,
// so this needs no step of its own.

import { describe, expect, test } from 'bun:test';
import {
  ASYNC_CONTEXT_SEAM,
  type AsyncStorageSite,
  asyncStorageFinding,
  checkAsyncStorage,
} from './async-context-guard';
import { collectSourceFiles } from './boundaries';
import { repoRoot } from './lib/run';

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

  test('its finding names the file, the line and a fix that is a call to paste', () => {
    const site = one('const store = new AsyncLocalStorage();')[0];
    const finding = asyncStorageFinding(site ?? expect.unreachable('no site was reported'));
    expect(finding.code).toBe('X_ASYNC_CONTEXT_UNAVAILABLE');
    expect(finding.at).toBe('packages/thing/src/scope.ts:1');
    expect(finding.fix).toContain("asyncContext<T>('what the scope carries')");
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

describe('the framework tree', () => {
  test('holds exactly one AsyncLocalStorage, and it is the seam', async () => {
    const files = await collectSourceFiles(repoRoot());
    // Non-vacuity: the collector must actually be reading the packages this rule is about.
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some((file) => file.path === 'packages/db/src/transaction.ts')).toBe(true);
    expect(checkAsyncStorage(files).map(asyncStorageFinding)).toEqual([]);
  }, 60_000);

  /**
   * The mutation, performed rather than described: the seam's REAL source, read off disk and
   * relabelled, is what a seventh module-scope construction would look like. A green run above
   * means the tree is clean only if this one is red.
   */
  test('would report the seam`s own construction from any other path', async () => {
    const files = await collectSourceFiles(repoRoot());
    const seam =
      files.find((file) => file.path === ASYNC_CONTEXT_SEAM) ??
      expect.unreachable(`${ASYNC_CONTEXT_SEAM} is not in the collected source set`);
    const sites = checkAsyncStorage([{ path: 'packages/core/src/moved.ts', source: seam.source }]);
    expect(kinds(sites)).toEqual(['binding:AsyncLocalStorage', 'construction:AsyncLocalStorage']);
  }, 60_000);
});
