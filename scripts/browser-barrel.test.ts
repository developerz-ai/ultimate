// Every package that touches the AsyncLocalStorage seam, bundled for the browser and evaluated —
// the end property, not the mechanism, one place for the whole repo.
//
// The guard in `scripts/async-context-guard.ts` reads source for `new AsyncLocalStorage()` at
// module scope and documents two blind spots it cannot see: `await import('node:async_hooks')`,
// and `const C = hooks.AsyncLocalStorage; new C()`. Both are closed here, and by two DIFFERENT
// assertions, because neither one closes both — measured, not assumed:
//
// | Reintroduced as | evaluates the chunk | no `node:async_hooks` in the chunk |
// |---|---|---|
// | `new AsyncLocalStorage()` at module scope | throws — caught | caught |
// | `const C = hooks.AsyncLocalStorage; new C()` | throws — caught | caught |
// | `await import('node:async_hooks')` at module scope | evaluates FINE — missed | caught |
// | the same four spelled BARE, `async_hooks` | never BUILDS — caught, loudest of the three |
//
// The dynamic form is missed by evaluation because these chunks are evaluated by Bun, where a
// dynamic specifier resolves to the real module at runtime; `target: 'browser'` leaves it in the
// output rather than stubbing it, which is why the text assertion is the one that sees it.
//
// WHAT THIS DOES NOT CLAIM: that these barrels are usable in a browser. `packages/db` statically
// imports `node:fs/promises` in `pglite-branch.ts`; the browser target elides the specifier, so the
// module EVALUATES and the call would throw. The claim is only that nothing constructs an
// AsyncLocalStorage while the module is being evaluated — which is the defect that shipped.
//
// AND NOT THAT EVERY package naming the seam is here: a package declaring a `bin` is a PROGRAM, no
// bundler has it as an entry, and it is excluded by `lib/browser-barrel-set.ts` — which states the
// reason and is where the set is derived. `scripts/async-context-guard.ts` is what still covers a
// program, statically and with no bundle at all.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserBarrels,
  CLIENT_BARRELS,
  isProgramPackage,
  seamPackages,
} from './lib/browser-barrel-set';
import { repoRoot, run } from './lib/run';

/**
 * DERIVED, never typed out, and it lives in `lib/browser-barrel-set.ts` because `describe.each`
 * needs the list at COLLECTION time and the derivation has its own tests. Two halves: what a
 * package's own source names, minus what runs as a program — a `bin` has no bundler, and
 * `@ultimat3/cli` reaching `bun:test` through the declared `cli → testing` edge is a build that
 * cannot succeed and is not this file's finding when it does not.
 */
const BARRELS = browserBarrels(repoRoot());

/** A browser build is ~1.3MB for `ai` and `entity`; the build IS the test, so the budget moves. */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * The SPECIFIER, never the bare string. `node:` is OPTIONAL because Bun resolves the bare spelling
 * identically — `await import('async_hooks')` walked straight past a `node:`-only pattern, which is
 * the one form the evaluation half cannot see either. `@ultimat3/core`'s own `X_ASYNC_CONTEXT_UNAVAILABLE` cause
 * says "node:async_hooks is stubbed to {} in this runtime" — a `toContain` on the words reports the
 * error message that PROVES the stub is working, which is the opposite of the finding.
 */
const HOOKS_SPECIFIER = /(?:from|import|require)\s*\(?\s*["'](?:node:)?async_hooks["']/;

/**
 * BOTH halves run in a SUBPROCESS, and neither started that way.
 *
 * `Bun.build` cannot resolve a `@ultimat3/*` specifier inside `bun test`: there is no
 * `node_modules/@ultimat3`, the workspace map belongs to the runtime, and the bundler in this
 * process does not consult it — `packages/db/src/client.ts` dies on
 * `Could not resolve "@ultimat3/core"`. The same build under `bun run` is fine. Resolving each name
 * by hand through a plugin fixed the build and broke something worse: the NEXT test file `bun test`
 * loaded then died on `Cannot find module '@ultimat3/http'`. Measured —
 * `bun test browser-barrel.test.ts` alone is green, and
 * `bun test browser-barrel.test.ts release.test.ts` loses all 26 of release's tests to a resolution
 * error in a file this one never touches. Building anywhere but here is the fix that has no
 * second-order effect, and a fresh process also makes "throws at module scope" mean exactly that.
 */
interface Chunk {
  readonly text: string;
  readonly file: string;
}

/** Built where the workspace map works: cwd is the repo root, and nothing is resolved by hand. */
const buildScript = (entry: string, out: string): string =>
  [
    `const built = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], target: 'browser' });`,
    'if (!built.success) { console.error(built.logs.map(String).join(" | ")); process.exit(1); }',
    'const chunk = built.outputs[0];',
    'if (chunk === undefined) { console.error("no chunk"); process.exit(1); }',
    `await Bun.write(${JSON.stringify(out)}, await chunk.text());`,
  ].join('\n');

/** The build with its verdict kept, because for one specifier the FAILURE is the finding. */
async function browserBuild(entry: string): Promise<Chunk & { ok: boolean; output: string }> {
  // A fresh path per build: a reused one would serve a chunk built before a fix.
  const file = join(await mkdtemp(join(tmpdir(), 'ultimate-barrel-')), 'barrel.mjs');
  const built = await run(['bun', '-e', buildScript(entry, file)], { cwd: repoRoot() });
  const text = built.ok ? await Bun.file(file).text() : '';
  return { text, file, ok: built.ok, output: built.output };
}

async function browserChunk(entry: string): Promise<Chunk> {
  const built = await browserBuild(entry);
  if (!built.ok) {
    expect.unreachable(`${entry} did not bundle for the browser: ${built.output}`);
  }
  return { text: built.text, file: built.file };
}

/** Whether evaluating the chunk throws, and with what — the shape a module-scope `new` produces. */
async function evaluationError(chunk: Chunk): Promise<string | undefined> {
  const result = await run(['bun', 'run', chunk.file], { cwd: repoRoot() });
  return result.ok ? undefined : result.output;
}

const entryFor = (name: string, source: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `ultimate-fixture-${name}-`)).then(async (dir) => {
    const entry = join(dir, 'entry.ts');
    await Bun.write(entry, source);
    return entry;
  });

const fixture = (name: string, source: string): Promise<Chunk> =>
  entryFor(name, source).then(browserChunk);

const barrelPath = (name: string): string => join(repoRoot(), 'packages', name, 'src/index.ts');

/**
 * A barrel is bundled the way an app consumes it — through a module that re-exports it — and never
 * as `Bun.build`'s own entry point.
 *
 * That is a **Bun 1.4.0 defect**, not a fact about these barrels: an entry module that declares
 * nothing of its own and is covered by a `sideEffects` field which does not NAME it is shaken down
 * to its export clause alone. `@ultimat3/core` built directly is 6,089 bytes of
 * `export { ACTOR_KINDS, … };` with not one declaration behind it, and `bun run` on it answers
 * `"ACTOR_KINDS" is not declared in this file`. Reproduced at two files and one line of
 * package.json — `sideEffects: false`, `[]`, or any array not naming the entry — identically on
 * the `browser`, `bun` and `node` targets. `export *` in the entry, one local declaration in the
 * entry, or naming the entry in `sideEffects` each make the chunk whole again.
 *
 * The wrapper RESTORES what this file claims rather than weakening it: the graph, the bundler and
 * the evaluation are the same, and the direct chunk had nothing in it for the specifier assertion
 * to be true OF. The defect is pinned as a negative control below, so the day Bun fixes it this
 * file reds and says the wrapper can go.
 */
const built = new Map<string, Promise<Chunk>>();

/**
 * One build per barrel per RUN. The three assertions below each asked for the same chunk, and the
 * `db-alias` control asks for a fourth — 13 subprocess builds where 4 answer the same question.
 * Measured on this tree: `ai` 152ms/1,263,194 B, `entity` 136ms/1,145,605 B, `db` 68ms, `core` 58ms,
 * so ~900ms and 18 abandoned `mkdtemp` directories per run went on rebuilding an immutable answer.
 *
 * Not in tension with `browserBuild`'s fresh path per build: that is about never serving a chunk
 * built BEFORE a fix, and no source in this repo changes between two tests of one process.
 */
const barrelChunk = (name: string): Promise<Chunk> => {
  const held = built.get(name);
  if (held !== undefined) return held;
  const chunk = fixture(`barrel-${name}`, `export * from ${JSON.stringify(barrelPath(name))};\n`);
  built.set(name, chunk);
  return chunk;
};

/** The chunk minus its trailing `export { … };` clause — the half a bad tree-shake empties. */
const bodyOf = (chunk: Chunk): string => chunk.text.replace(/export\s*\{[^}]*\};?\s*$/, '').trim();

// Negative controls first: without these the two assertions below could both be vacuously true,
// which is exactly what a browser test evaluated under Bun is at risk of being.
describe('the harness can fail', () => {
  test(
    'a module-scope construction through an ALIAS throws when the chunk is evaluated',
    async () => {
      const chunk = await fixture(
        'alias',
        [
          "import * as hooks from 'node:async_hooks';",
          'const Ctor = hooks.AsyncLocalStorage;',
          'export const store = new Ctor();',
          '',
        ].join('\n'),
      );
      expect(await evaluationError(chunk)).toContain('undefined is not a constructor');
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    'a module-scope `await import` survives evaluation and is caught by the specifier instead',
    async () => {
      const chunk = await fixture(
        'dynamic',
        [
          "const hooks = await import('node:async_hooks');",
          'export const store = new hooks.AsyncLocalStorage();',
          '',
        ].join('\n'),
      );
      // Evaluates cleanly under Bun — this is the blind spot the second assertion exists for.
      expect(await evaluationError(chunk)).toBeUndefined();
      expect(HOOKS_SPECIFIER.test(chunk.text)).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );

  /**
   * The mutation, applied to a REAL barrel graph rather than to a two-line fixture: `@ultimat3/db`
   * plus one aliased module-scope construction. Editing `packages/db` to prove this would be the
   * honest experiment and cannot be run here — a second agent is writing that tree — so the
   * reintroduction is grafted onto the real barrel at the entry point instead. Same graph, same
   * bundler, same evaluation.
   */
  test(
    'a real barrel that GAINS an aliased construction reds the same assertion',
    async () => {
      const chunk = await fixture(
        'db-alias',
        [
          `export * from ${JSON.stringify(barrelPath('db'))};`,
          "import * as hooks from 'node:async_hooks';",
          'const Ctor = hooks.AsyncLocalStorage;',
          'export const grafted = new Ctor();',
          '',
        ].join('\n'),
      );
      expect(await evaluationError(chunk)).toContain('undefined is not a constructor');
      // And the barrel as it stands does not, so the graft is what moved the answer.
      expect(await evaluationError(await barrelChunk('db'))).toBeUndefined();
    },
    BUILD_TIMEOUT_MS,
  );

  /**
   * The workaround `barrelChunk` exists for, proved on a package of two files rather than
   * asserted about a real one — so it stays true whichever `sideEffects` the tree's own
   * package.json files carry this week.
   *
   * It is a PIN on a Bun 1.4.0 defect: when this test reds, Bun shakes an entry-point barrel
   * correctly and `barrelChunk` can go back to building `packages/<name>/src/index.ts` directly.
   */
  test(
    'a re-export-only barrel built as its OWN entry point is shaken to an export clause, and nothing else',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ultimate-shake-'));
      // The whole trigger: the entry declares nothing of its own, and `sideEffects` does not name it.
      await Bun.write(
        join(root, 'package.json'),
        '{ "name": "shake", "type": "module", "sideEffects": false }\n',
      );
      await Bun.write(join(root, 'src/a.ts'), 'export const a = 1;\n');
      await Bun.write(join(root, 'src/index.ts'), "export { a } from './a';\n");

      const direct = await browserChunk(join(root, 'src/index.ts'));
      expect(bodyOf(direct)).toBe('');
      expect(await evaluationError(direct)).toContain('is not declared in this file');

      // The same two files reached through a re-exporting module: whole, and it evaluates.
      const wrapped = await fixture(
        'shake-wrapped',
        `export * from ${JSON.stringify(join(root, 'src/index.ts'))};\n`,
      );
      expect(bodyOf(wrapped)).toContain('a = 1');
      expect(await evaluationError(wrapped)).toBeUndefined();
    },
    BUILD_TIMEOUT_MS,
  );

  /**
   * The bare spelling Bun resolves identically at RUNTIME does not survive the bundler at all —
   * measured, all four forms (`import from`, `import * as`, `await import`, `require`) — so it
   * reaches neither assertion below and is caught one step earlier, by `browserChunk`'s
   * `expect.unreachable`. Pinned because the widened `HOOKS_SPECIFIER` is the fallback for the day
   * this stops being true: if Bun ever bundles a bare builtin, THIS test reds first and says where.
   */
  test(
    'the BARE specifier never reaches an assertion — the browser build refuses to bundle it',
    async () => {
      const entry = await entryFor(
        'dynamic-bare',
        "const hooks = await import('async_hooks');\nexport const store = new hooks.AsyncLocalStorage();\n",
      );
      const built = await browserBuild(entry);
      expect(built.ok).toBe(false);
      expect(built.output).toContain('async_hooks');
    },
    BUILD_TIMEOUT_MS,
  );

  test('and the pattern that would see it carries no `node:` requirement', () => {
    expect(HOOKS_SPECIFIER.test("const hooks = await import('async_hooks');")).toBe(true);
    expect(HOOKS_SPECIFIER.test("import * as hooks from 'node:async_hooks';")).toBe(true);
    expect(HOOKS_SPECIFIER.test("require('async_hooks')")).toBe(true);
    // The negative control this pattern exists for: core's own cause line names the module, and a
    // `toContain` on the words would report the error message that PROVES the stub is working.
    expect(HOOKS_SPECIFIER.test('node:async_hooks is stubbed to {} in this runtime')).toBe(false);
  });

  test(
    'a module that touches neither is clean on both',
    async () => {
      const chunk = await fixture('clean', 'export const ok = (): boolean => true;\n');
      expect(await evaluationError(chunk)).toBeUndefined();
      expect(HOOKS_SPECIFIER.test(chunk.text)).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe('the barrel set', () => {
  // The derivation's own tests — the floor, the synthetic trees, and why a program is excluded —
  // live beside it in `lib/browser-barrel-set.test.ts`. What is asserted here is what a barrel in
  // the set must DO when it is bundled, which is the only half that needs a subprocess.

  test('a barrel is built ONCE per run, not once per assertion', async () => {
    const name = BARRELS[0] as string;
    const [first, second] = await Promise.all([barrelChunk(name), barrelChunk(name)]);
    // The same object, not an equal one: two callers, one build, one temp directory.
    expect(first).toBe(second);
    expect(barrelChunk(name)).toBe(barrelChunk(name));
  });

  test('and every derived entry has a barrel this suite can build', () => {
    for (const name of BARRELS) {
      const barrel = join(repoRoot(), 'packages', name, 'src/index.ts');
      expect(existsSync(barrel)).toBe(true);
    }
  });
});

// `[...BARRELS]`, not `BARRELS`: `describe.each<const T>(table: T[])` wants a MUTABLE array, and a
// `readonly` one is 20 x TS2769 under `bun run typecheck`. scripts/tsconfig.json includes
// `**/*.ts` with no test exclusion, so a green `bun test` is not evidence for a file in scripts/.
describe.each([...BARRELS])('a browser bundle of @ultimat3/%s', (name) => {
  test(
    'evaluates instead of throwing at module scope',
    async () => {
      expect(await evaluationError(await barrelChunk(name))).toBeUndefined();
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    'carries no node:async_hooks specifier into the chunk',
    async () => {
      expect(HOOKS_SPECIFIER.test((await barrelChunk(name)).text)).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );

  /**
   * Non-vacuity, and it is not hypothetical: an EMPTY chunk satisfies the specifier assertion
   * above by having nothing in it, which is exactly what building these barrels as entry points
   * produced. Both halves of this file's claim need a chunk that carries the barrel's code.
   */
  test(
    'and the chunk carries the code, not just the names of it',
    async () => {
      expect(bodyOf(await barrelChunk(name))).not.toBe('');
    },
    BUILD_TIMEOUT_MS,
  );
});

/**
 * The exclusion's non-vacuity, and the one thing the derivation's own tests cannot ask: a program
 * that names the seam is left out of the set above, and this proves the build it was left out of
 * genuinely cannot succeed — so the exclusion is hiding no green bundle. It reds the day a program
 * becomes browser-bundlable, which is the day the exclusion is doing more than it has to.
 *
 * An empty set here passes trivially, and that is honest: no program names the seam, so the
 * exclusion is inert and there is nothing to be non-vacuous about.
 */
test(
  'a program left out of the set could not have been bundled anyway',
  async () => {
    for (const name of seamPackages(repoRoot()).filter((dir) =>
      isProgramPackage(repoRoot(), dir),
    )) {
      const built = await browserBuild(barrelPath(name));
      expect(built.ok ? `@ultimat3/${name} bundled for the browser` : '').toBe('');
    }
  },
  BUILD_TIMEOUT_MS,
);

describe.each([...CLIENT_BARRELS])('the client barrel @ultimat3/%s', (name) => {
  test(
    'bundles for the browser at all',
    async () => {
      const built = await browserBuild(barrelPath(name));
      expect(built.ok ? '' : built.output).toBe('');
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    'evaluates, carries its code, and drags no node:async_hooks in',
    async () => {
      const chunk = await barrelChunk(name);
      expect(await evaluationError(chunk)).toBeUndefined();
      expect(bodyOf(chunk)).not.toBe('');
      expect(HOOKS_SPECIFIER.test(chunk.text)).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});

/**
 * The other half of the split, and the reason the line above is a CONTRACT rather than a bundler's
 * discretion: `@ultimat3/render/server` still cannot be bundled for the browser, and for exactly
 * the reason the whole `"."` barrel could not until 2026-08-22 —
 * `packages/render/src/css-modules.ts:9` imports `fileURLToPath` and `pathToFileURL` from
 * `node:url`, which Bun's browser polyfill exports neither of.
 *
 * Non-vacuity for `'render'`'s entry in `CLIENT_BARRELS`: without this, a client barrel that
 * bundles because someone made `css-modules.ts` browser-safe (or deleted it) would read the same
 * as one that bundles because the build-time half is unreachable from it. It is the second that is
 * being claimed. This test is not a pin on a gap — it reds if the two halves are ever rejoined.
 */
test(
  'the build-time half is still unbundlable, so the client half passing means it cannot reach it',
  async () => {
    const built = await browserBuild(join(repoRoot(), 'packages/render/src/server.ts'));
    expect(built.ok).toBe(false);
    expect(built.output).toContain('node:url');
    expect(built.output).toContain('css-modules.ts');
  },
  BUILD_TIMEOUT_MS,
);
