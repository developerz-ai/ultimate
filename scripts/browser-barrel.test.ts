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

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, run } from './lib/run';

/** A package's own source naming the seam, either half of it. Over-approximate on purpose: a
 * mention in a comment costs one 25ms build, a missed adoption costs the browser bundle. */
const SEAM = /\basyncContext\b|\bAsyncLocalStorage\b/;

/**
 * DERIVED, never typed out — `readFileSync` because `describe.each` needs the list at collection
 * time. A hand-copied set is the defect class this whole check exists to close: a fifth package
 * adopting the seam would simply not be bundled and the suite would stay green. Measured: 2,798
 * files read in 59ms, answering the same four the hand list named, so the derivation costs nothing.
 */
function seamPackages(root: string): readonly string[] {
  const found = new Set<string>();
  for (const path of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scanSync({ cwd: root })) {
    const posix = path.split('\\').join('/');
    // A test is in nobody's bundle — the same exemption `scripts/async-context-guard.ts` makes.
    if (posix.includes('.test.')) continue;
    if (!SEAM.test(readFileSync(join(root, posix), 'utf8'))) continue;
    const name = posix.split('/')[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

const BARRELS = seamPackages(repoRoot());

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
const barrelChunk = (name: string): Promise<Chunk> =>
  fixture(`barrel-${name}`, `export * from ${JSON.stringify(barrelPath(name))};\n`);

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
  /**
   * The derivation's own non-vacuity, and the only line here a human ever edits. A FLOOR, not a
   * pin: a new adopter arrives by derivation and needs no entry, so this list can only ever
   * SHRINK — and it shrinks when a package genuinely stops naming the seam, which is a fact worth
   * one deliberate deletion. Without it a `seamPackages` that returned nothing would register zero
   * `describe.each` blocks and the file would report "0 fail".
   */
  test('is derived from source and still covers every package known to touch the seam', () => {
    for (const name of ['ai', 'core', 'db', 'entity']) expect(BARRELS).toContain(name);
  });

  /**
   * The derivation over a tree with a known answer, so "it happens to name the right four today"
   * and "it would name a fifth tomorrow" are separate claims. Three at once: a package that adopts
   * the seam enters, a package that does not stays out, and a `.test.ts` counts for nobody.
   */
  test('a package that adopts the seam tomorrow enters the set by existing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-seam-'));
    await Bun.write(
      join(root, 'packages/adopter/src/scope.ts'),
      "import { asyncContext } from '@ultimat3/core';\n",
    );
    await Bun.write(join(root, 'packages/quiet/src/index.ts'), 'export const ok = 1;\n');
    await Bun.write(
      join(root, 'packages/tested/src/a.test.ts'),
      'const store = new AsyncLocalStorage();\n',
    );
    expect(seamPackages(root)).toEqual(['adopter']);
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
