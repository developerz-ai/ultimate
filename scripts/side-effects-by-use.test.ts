// The half of `scripts/side-effects.ts` that exists because Bun honours the array since 1.4.1:
// `SIDE_EFFECTS_BY_USE`, the modules whose import-time effect only their own bindings need, held by
// fixtures and by a real browser build. Split from `side-effects.test.ts` at the line ceiling.

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { PackageFacts, SideEffectGap } from './side-effects';
import {
  checkSideEffects,
  PINS_FILE,
  SIDE_EFFECTS_BY_USE,
  sideEffectFinding,
} from './side-effects';

// Its own directory, not `side-effects.test.ts`'s `.side-effects-fixture`: that one is torn down by
// another file's hooks, and the gate runs the two files in parallel.
const BUILD_FIXTURE = join(repoRoot(), 'scripts', '.side-effects-by-use-fixture');

const pkg = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  dir: 'packages/x',
  name: '@ultimat3/x',
  declared: ['./src/errors.ts'],
  files: ['src/errors.ts', 'src/index.ts', 'package.json'],
  effects: [{ path: 'src/errors.ts', line: 12 }],
  anchored: ['src/index.ts', 'src/errors.ts'],
  ...over,
});

const check = (packages: readonly PackageFacts[], byUse: Readonly<Record<string, string>> = {}) =>
  checkSideEffects({ packages, pins: [], anchors: {}, byUse });

describe('a module whose effect only its own bindings need', () => {
  // `core/context.ts` is the case: its import-time call installs the logger's context provider,
  // which can answer only inside a context that module's own `runWithContext` opens. Listed, a
  // bundler that honours the array (Bun >= 1.4.1) keeps it in every chunk that reaches the barrel.
  const BY_USE = { 'packages/x/src/context.ts': 'only its own bindings open a context' };
  const withContext = (over: Partial<PackageFacts> = {}): PackageFacts =>
    pkg({
      files: ['src/errors.ts', 'src/context.ts', 'src/index.ts', 'package.json'],
      effects: [
        { path: 'src/context.ts', line: 3 },
        { path: 'src/errors.ts', line: 12 },
      ],
      ...over,
    });

  test('is exempt from the array when SIDE_EFFECTS_BY_USE names it', () => {
    expect(check([withContext()], BY_USE)).toEqual([]);
    // And without the row it is the plain undeclared finding, so the row is what exempts it.
    expect(check([withContext()]).map((gap) => gap.subject)).toEqual(['src/context.ts']);
  });

  test('a row whose module the array ALSO lists is stale — the array wins, and costs bytes', () => {
    const gaps = check(
      [withContext({ declared: ['./src/errors.ts', './src/context.ts'] })],
      BY_USE,
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['by-use-stale']);
    const finding = sideEffectFinding(gaps[0] as SideEffectGap);
    expect(finding.code).toBe('X_SIDE_EFFECTS_BY_USE_STALE');
    expect(finding.cause).toContain('packages/x/package.json');
    expect(finding.at).toBe(PINS_FILE);
  });

  test('a row whose module runs nothing at import is stale', () => {
    const gaps = check([pkg()], BY_USE);
    expect(gaps.map((gap) => [gap.kind, gap.subject])).toEqual([
      ['by-use-stale', 'packages/x/src/context.ts'],
    ]);
  });

  test('a row whose module an entry imports BARE is stale — unlisted, that import is dropped', () => {
    const gaps = check(
      [withContext({ anchored: ['src/index.ts', 'src/errors.ts', 'src/context.ts'] })],
      BY_USE,
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['by-use-stale']);
    expect(sideEffectFinding(gaps[0] as SideEffectGap).cause).toContain('bare');
  });
});

describe('this repository', () => {
  test(
    'a real browser build keeps the anchored effects and drops the ones only bindings need',
    async () => {
      // The test that would have caught #40650, and since Bun 1.4.1 honours the array it measures
      // RETENTION, not a flap: a module the array lists is kept in every chunk that reaches its
      // package's barrel, whether or not anything uses it. So both halves are claims about the
      // ARRAY now. The anchors must survive with no binding used; the `SIDE_EFFECTS_BY_USE` rows
      // must not ride along — listed, `core/context.ts` alone measured +3,485 B on this chunk, and
      // the three together ~5.4 kB on every one of `examples/dummy`'s core-reaching islands
      // (2026-10-05, Bun 1.4.2), for a logger provider no browser can fire and two server-only
      // code tables.
      //
      // A CONSUMER entry, never the barrel itself — the shape every app uses, and the one that
      // was safe even on the Bun 1.4.0 `side-effects.ts`'s header records.
      const build = async (name: string, names: string): Promise<string> => {
        const entry = join(BUILD_FIXTURE, `${name}.ts`);
        await Bun.write(
          entry,
          `import { ${names} } from '../../packages/core/src/index';\nexport const go = [${names}];\n`,
        );
        const built = await Bun.build({ entrypoints: [entry], target: 'browser', minify: false });
        expect(built.success).toBe(true);
        return await (built.outputs[0] as Bun.BuildArtifact).text();
      };
      let code: string;
      let used: string;
      try {
        code = await build('consumer', 'uuidV7');
        // The other direction, and the reason an unlisted module is safe: a chunk that USES the
        // module's bindings keeps its import-time statement. `runWithContext` is the only way a
        // context exists, so the provider install rides along exactly where it can answer.
        used = await build('context-user', 'runWithContext, ctxOf, logger');
      } finally {
        await rm(BUILD_FIXTURE, { recursive: true, force: true });
      }
      expect(used).toContain('packages/core/src/context.ts');
      expect(used).toContain('setLoggerContextFields(() =>');

      // `uuidV7` reaches them through nothing — that is the point. They are in the chunk because
      // `src/index.ts` imports them bare and the array lists them, and for no other reason.
      for (const module of ['core-error-codes.ts', 'schema-error-codes.ts']) {
        expect(code, `${module} must survive a browser build`).toContain(`core/src/${module}`);
      }
      const byUse = Object.keys(SIDE_EFFECTS_BY_USE).filter((path) =>
        path.startsWith('packages/core/'),
      );
      expect(byUse.length).toBeGreaterThan(0);
      for (const module of byUse) {
        expect(code, `${module} must not be dragged in`).not.toContain(
          module.slice('packages/'.length),
        );
      }
      // The guard against a vacuous pass: an unminified Bun chunk carries a `// <path>` banner per
      // module, so a build that emitted nothing recognisable would satisfy the loop above by
      // accident if the banners were gone.
      expect(code).toContain('packages/core/src/ids.ts');
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('exempts exactly the three core modules whose effect only their own bindings need', () => {
    // A list and not a predicate, for the reason `SIDE_EFFECTS_ANCHORS` is one — and each row is a
    // measured claim, so one more row is a decision for review rather than a quiet exemption.
    expect(Object.keys(SIDE_EFFECTS_BY_USE).sort()).toEqual([
      'packages/core/src/context.ts',
      'packages/core/src/lifecycle-errors.ts',
      'packages/core/src/secrets-errors.ts',
    ]);
  });
});
