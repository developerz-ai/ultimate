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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, run } from './lib/run';

/** Every package whose source names the seam. Re-derive with `grep -rl AsyncLocalStorage` under
 * each package's `src`, never by memory: a fifth adoption site that is not here is not guarded. */
const BARRELS = ['ai', 'core', 'db', 'entity'] as const;

/** A browser build is ~1.3MB for `ai` and `entity`; the build IS the test, so the budget moves. */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * The SPECIFIER, never the bare string. `@ultimat3/core`'s own `X_ASYNC_CONTEXT_UNAVAILABLE` cause
 * says "node:async_hooks is stubbed to {} in this runtime" — a `toContain` on the words reports the
 * error message that PROVES the stub is working, which is the opposite of the finding.
 */
const HOOKS_SPECIFIER = /(?:from|import|require)\s*\(?\s*["']node:async_hooks["']/;

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

async function browserChunk(entry: string): Promise<Chunk> {
  // A fresh path per build: a reused one would serve a chunk built before a fix.
  const file = join(await mkdtemp(join(tmpdir(), 'ultimate-barrel-')), 'barrel.mjs');
  const built = await run(['bun', '-e', buildScript(entry, file)], { cwd: repoRoot() });
  if (!built.ok) {
    expect.unreachable(`${entry} did not bundle for the browser: ${built.output}`);
  }
  return { text: await Bun.file(file).text(), file };
}

/** Whether evaluating the chunk throws, and with what — the shape a module-scope `new` produces. */
async function evaluationError(chunk: Chunk): Promise<string | undefined> {
  const result = await run(['bun', 'run', chunk.file], { cwd: repoRoot() });
  return result.ok ? undefined : result.output;
}

const fixture = (name: string, source: string): Promise<Chunk> =>
  mkdtemp(join(tmpdir(), `ultimate-fixture-${name}-`))
    .then(async (dir) => {
      const entry = join(dir, 'entry.ts');
      await Bun.write(entry, source);
      return entry;
    })
    .then(browserChunk);

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
      const barrel = join(repoRoot(), 'packages/db/src/index.ts');
      const chunk = await fixture(
        'db-alias',
        [
          `export * from ${JSON.stringify(barrel)};`,
          "import * as hooks from 'node:async_hooks';",
          'const Ctor = hooks.AsyncLocalStorage;',
          'export const grafted = new Ctor();',
          '',
        ].join('\n'),
      );
      expect(await evaluationError(chunk)).toContain('undefined is not a constructor');
      // And the barrel as it stands does not, so the graft is what moved the answer.
      expect(await evaluationError(await browserChunk(barrel))).toBeUndefined();
    },
    BUILD_TIMEOUT_MS,
  );

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

// `[...BARRELS]`, not `BARRELS`: `describe.each<const T>(table: T[])` wants a MUTABLE array, and a
// `readonly` tuple is 20 x TS2769 under `bun run typecheck`. scripts/tsconfig.json includes
// `**/*.ts` with no test exclusion, so a green `bun test` is not evidence for a file in scripts/.
describe.each([...BARRELS])('a browser bundle of @ultimat3/%s', (name) => {
  const entry = (): string => join(repoRoot(), 'packages', name, 'src/index.ts');

  test(
    'evaluates instead of throwing at module scope',
    async () => {
      expect(await evaluationError(await browserChunk(entry()))).toBeUndefined();
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    'carries no node:async_hooks specifier into the chunk',
    async () => {
      expect(HOOKS_SPECIFIER.test((await browserChunk(entry())).text)).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );
});
