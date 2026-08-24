// Which barrels `scripts/browser-barrel.test.ts` bundles, derived from the tree in two halves:
// what a package's own source NAMES (the AsyncLocalStorage seam), minus what a bundler can never
// REACH (a program). One module because those are one question — whose modules does a browser
// evaluate? — and the suite must never answer it with a hand-typed list.

// why: `describe.each` needs the list at COLLECTION time and Bun has no synchronous file read of
// its own — `Bun.file(path).text()` is a promise — so `node:fs` is the only reader that answers.
import { existsSync, readFileSync } from 'node:fs';
// why: Bun ships no path join; `Bun.Glob` yields POSIX paths and these have to reach an absolute
// root that the caller supplies, which is the one case a string concatenation gets wrong.
import { join } from 'node:path';
import { isJsonObject } from '@ultimat3/core';

/** A package's own source naming the seam, either half of it. Over-approximate on purpose: a
 * mention in a comment costs one 25ms build, a missed adoption costs the browser bundle. */
export const SEAM = /\basyncContext\b|\bAsyncLocalStorage\b/;

/**
 * DERIVED, never typed out — a hand-copied set is the defect class the suite exists to close: a
 * fifth package adopting the seam would simply not be bundled and it would stay green. Measured:
 * 2,798 files read in 59ms, answering the same four the hand list named, so this costs nothing.
 */
export function seamPackages(root: string): readonly string[] {
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

/** A package directory's declared name, and whether it declares a `bin`. */
export interface PackageFacts {
  readonly name: string;
  readonly program: boolean;
}

/** Parsed from `unknown` and never cast: a manifest that parses is not a manifest of any shape. */
export function packageFacts(root: string, dir: string): PackageFacts | undefined {
  const path = join(root, 'packages', dir, 'package.json');
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A manifest nobody can parse is not evidence of a program, and this module is not the place
    // that reports it — `x verify`'s `package-shape` step already refuses one by name.
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  const name = parsed['name'];
  return {
    name: typeof name === 'string' ? name : `@ultimat3/${dir}`,
    program: parsed['bin'] !== undefined,
  };
}

/**
 * A package that declares a `bin` is a PROGRAM — a shell runs it, a bundler never has it as an
 * entry — and it is excluded from the browser barrel set for that reason alone.
 *
 * This NARROWS the question rather than putting a hole in it. The defect the suite catches is a
 * `TypeError: undefined is not a constructor` at module EVALUATION in a browser, and a module no
 * browser evaluates cannot produce one. What still covers a program is
 * `scripts/async-context-guard.ts`, which refuses a `new AsyncLocalStorage` and the import that
 * binds the class in EVERY package, statically, with no bundle at all.
 *
 * Measured, and the reason this exists: `@ultimat3/cli` entered the seam set on 2026-08-24 —
 * `packages/cli/src/dev-replica.ts` names the seam in a comment — and three assertions went red on
 * a build that CANNOT succeed. `packages/testing/src/index.ts:25` re-exports `bun:test` and
 * `nats/lib/src/mod.js:49` requires `stream/web`, both reached legitimately through the declared
 * `cli → testing` edge. No edit inside `packages/cli` makes that build green, so the set had been
 * asking a question of a package the question does not apply to.
 *
 * NOT the tier, which was the other candidate and is wrong: `@ultimat3/admin` is tier 5 and is a
 * dashboard whose components ship to a browser. `bin` is the shape of a program; a tier is the
 * shape of an import graph.
 */
export const isProgramPackage = (root: string, dir: string): boolean =>
  packageFacts(root, dir)?.program === true;

/** Every program in the tree, in directory order — the excluded set, derived and never listed. */
export const programPackages = (root: string): readonly string[] =>
  [...new Bun.Glob('packages/*/package.json').scanSync({ cwd: root })]
    .map((path) => path.split('\\').join('/').split('/')[1] ?? '')
    .filter((dir) => dir !== '' && isProgramPackage(root, dir))
    .sort();

/** The seam set a browser can actually evaluate: what names the seam, minus what runs as a program. */
export const browserBarrels = (root: string): readonly string[] =>
  seamPackages(root).filter((dir) => !isProgramPackage(root, dir));

/**
 * The barrels an app's BROWSER bundle actually reaches, which is a different question from the seam
 * and is why they are listed rather than derived: `@ultimat3/realtime`'s `"."` is its CLIENT entry
 * (`"./server"` is the other half, split 2026-08), `@ultimat3/render`'s `"."` is the same shape
 * (split 2026-08-22, the same `"./server"` spelling), `@ultimat3/pwa` runs in a service worker and
 * `@ultimat3/ui` is the design system. `packages/cli/src/island-bundle.ts:80` is the build that
 * consumes them — `Bun.build({ target: 'browser' })` over an app's island graph — so a barrel that
 * cannot be bundled is a `bun run build` failure in an app, not a theoretical one.
 */
export const CLIENT_BARRELS = ['realtime', 'render', 'pwa', 'ui'] as const;

export interface ProgramImport {
  readonly importer: string;
  readonly program: string;
}

/**
 * Every import of a program from a package that is NOT one — the soundness condition of the
 * exclusion above, and the one thing that could turn it into a hole. A program's modules re-enter
 * a bundle graph the moment a library imports it, and then they are back in the browser's reach
 * with nothing bundling them here. Package names in this tree carry no regex metacharacter, so the
 * specifier goes into the pattern as written; a subpath (`@ultimat3/render/server`) counts.
 */
export function programImports(root: string): readonly ProgramImport[] {
  const programs = programPackages(root);
  if (programs.length === 0) return [];
  const named = programs.map((dir) => ({ dir, name: packageFacts(root, dir)?.name ?? dir }));
  // Keyed, because one importer reaching a program from four files is one finding and not four.
  const found = new Map<string, ProgramImport>();
  for (const path of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scanSync({ cwd: root })) {
    const posix = path.split('\\').join('/');
    const importer = posix.split('/')[1];
    if (importer === undefined || posix.includes('.test.')) continue;
    if (programs.includes(importer)) continue;
    const source = readFileSync(join(root, posix), 'utf8');
    for (const program of named) {
      const pattern = `(?:from|import|require)\\s*\\(?\\s*['"]${program.name}(?:/[\\w./-]+)?['"]`;
      if (!new RegExp(pattern).test(source)) continue;
      found.set(`${importer} ${program.dir}`, { importer, program: program.dir });
    }
  }
  return [...found.values()];
}
