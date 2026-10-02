// What counts as an app's OWN source for the coverage floor, and what a file no test loaded
// weighs. Bun writes an lcov record only for a file something imported, so a module nothing
// reaches is absent from both halves of the fraction — and makes the number BETTER.

// why: Bun ships no path-joining primitive; `join` builds the host path to each source file.
import { join } from 'node:path';
import { maskLiterals, stripComments } from '@ultimat3/core';

/** A test file, whatever its suite: `*.test.ts`, `*.contract.test.tsx`, … */
export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Index just past the balanced `{ … }` that starts at or after `from`. */
function skipBalanced(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Index just past the `;` that ends a `type` alias — the first one at nesting depth zero.
 *
 * Depth matters and a naive scan gets it wrong: `type _A = Assert<[FactKeysOf<{ a: 1 }>] extends
 * [Actor] ? true : false>;` contains a `{ … }` whose closing brace is NOT the end of the
 * declaration, and matching braces there leaves `, ] extends [Actor] … >;` behind, which then
 * reads as executable code.
 */
function endOfTypeAlias(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')' || ch === '>') depth -= 1;
    else if (ch === ';' && depth <= 0) return i + 1;
  }
  return text.length;
}

/**
 * Whether a file emits anything at RUNTIME, as opposed to a barrel or a types-only module.
 *
 * Load-bearing, not cosmetic: bun writes an lcov record only for a file that produced executable
 * code, so a pure barrel and a types-only module are legitimately absent — while a real module
 * nothing imported is absent for the opposite reason and must be reported.
 * `packages/core/src/type-pins.ts` says it of itself: "This module emits nothing and exports
 * nothing anybody imports."
 *
 * A regex cannot decide this. `metrics-types.ts` contains `(() => number)` in a TYPE position, so
 * scanning for `=>` calls a types-only file executable. Hence a scanner: strip comments and
 * re-export statements, then remove `interface` blocks by brace matching and `type` aliases to
 * their depth-zero `;`, and ask whether anything is left.
 *
 * `declare module` and `declare global` are removed the same way, and for the same reason the
 * `declare const` line exists: an ambient block emits nothing at runtime, so bun writes no lcov
 * record for a file built only from one. Their bodies go with them — an augmentation's members
 * are declarations whatever they look like. Without this, `matcher-surface.ts` (a
 * `declare module 'bun:test'` and nothing else) read as executable and was reported as a real
 * module no test imports, which is the opposite of what it is.
 */
export function hasExecutableCode(source: string): boolean {
  let text = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*(?:import|export)\b[^;]*?from\s*'[^']*';[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s+type\b[^;]*;[ \t]*$/gm, '')
    // `declare const x: T;` is ambient — it emits nothing, and `type-pins.ts` files are built
    // almost entirely from them.
    .replace(/^[ \t]*declare\s+(?:const|let|var|function|class)\b[^;]*;[ \t]*$/gm, '');

  // Ambient blocks first: their bodies hold `interface` members that the loop below would strip
  // individually, leaving a bare `declare module '…' { }` shell behind that reads as code.
  for (;;) {
    const ambient = /(?:^|\n)[ \t]*declare\s+(?:module\s+'[^']*'|global)\s*\{/.exec(text);
    if (ambient === null) break;
    const start = ambient.index + (ambient[0].startsWith('\n') ? 1 : 0);
    text = text.slice(0, start) + text.slice(skipBalanced(text, text.indexOf('{', start)));
  }

  for (;;) {
    const found = /(?:^|\n)[ \t]*(?:export\s+)?(?:declare\s+)?(interface|type)\s/.exec(text);
    if (found === null) break;
    const start = found.index + (found[0].startsWith('\n') ? 1 : 0);
    const end =
      found[1] === 'interface'
        ? skipBalanced(text, text.indexOf('{', start))
        : endOfTypeAlias(text, start);
    text = text.slice(0, start) + text.slice(end);
  }
  return text.replace(/\s/g, '') !== '';
}

/**
 * What a file with NO lcov record weighs, read off its source because nothing else knows: its
 * non-blank, non-comment lines, and one function per `function` keyword or arrow (at least one —
 * it has executable code, or it would not be asked). An estimate, deliberately on the heavy side
 * of what Bun reports for a loaded file (1.34x over `examples/dummy`'s loaded sources,
 * 2026-10-01): the only way to make it exact is to load the file from a test, which is the fix.
 */
export function unloadedWeight(source: string): { readonly lines: number; readonly funcs: number } {
  const stripped = stripComments(source);
  const lines = stripped.split('\n').filter((line) => line.trim() !== '').length;
  const funcs = (maskLiterals(stripped).match(/\bfunction\b|=>/g) ?? []).length;
  return { lines: Math.max(1, lines), funcs: Math.max(1, funcs) };
}

/** Never an app's own source, wherever it sits. */
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|build|\.x)\//;

/**
 * Every `.ts` / `.tsx` under the app's `apps/` and `packages/` that is its own source: not a
 * test, not a declaration file, not installed or built output, and not excluded by `exclude`
 * (globs relative to the app root). Sorted, so two runs of one tree read one list.
 */
export function appSourceFiles(root: string, exclude: readonly string[] = []): readonly string[] {
  const globs = exclude.map((pattern) => new Bun.Glob(pattern));
  const files: string[] = [];
  for (const rel of new Bun.Glob('{apps,packages}/**/*.{ts,tsx}').scanSync({ cwd: root })) {
    const path = rel.split('\\').join('/');
    if (NOT_SOURCE.test(path) || TEST_FILE.test(path) || path.endsWith('.d.ts')) continue;
    if (globs.some((glob) => glob.match(path))) continue;
    files.push(path);
  }
  return files.sort();
}

/** The source text of `rel` under `root`, or nothing when it cannot be read. */
export const readSource = (root: string, rel: string): Promise<string | undefined> =>
  Bun.file(join(root, rel))
    .text()
    .catch(() => undefined);
