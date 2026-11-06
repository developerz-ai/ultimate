// An island's `mount` hands back its disposer, made a build error: the client router disposes an
// island by calling what `mount` resolved to (`disposeIslands`), so a `mount(): void` is never
// released and its listeners, hotkey tables and live reads stay registered across navigations.
// Pure over the `boundaries` step's one read; no type can carry it, an island is a specifier.

import { ERROR_DOCS_URL, maskLiterals } from '@ultimat3/core';
import { ISLAND_EXTENSION } from '@ultimat3/render';
import type { SourceFile } from './app-boundaries';
import { commentSafe } from './comment-safe';
import type { Finding } from './output';

/** `function mount(` and `async function mount<T>(` — the declaration form. */
const DECLARED = /\b(?:async\s+)?function\s+mount\s*(?:<[^>]*>)?\s*\(/;
/** `const mount = (`, `= async (`, `= function (` — an unannotated binding. */
const BOUND = /\b(?:const|let|var)\s+mount\s*=\s*(?:async\s+)?(?:function\b[^(]*)?\(/;
/** The annotations that SAY nothing comes back; any other one is the type checker's to hold. */
const VOID_ANNOTATION = /^:\s*(?:void|undefined|Promise\s*<\s*(?:void|undefined)\s*>)\s*$/;
/** A `(…) {` that opens a statement block, not a function's body. */
const CONTROL_WORDS: ReadonlySet<string> = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
]);

/** The index closing the bracket opened at `open`, or `-1`. Exact over `maskLiterals` output. */
function closeOf(masked: string, open: number): number {
  const opener = masked[open];
  const closer = opener === '(' ? ')' : '}';
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === opener) depth += 1;
    else if (masked[index] === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The `(` matching the `)` at `close`, scanning backwards. */
function openOf(masked: string, close: number): number {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    if (masked[index] === ')') depth += 1;
    else if (masked[index] === '(') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Whether the `{` at `brace` opens a nested function's body: `=> {`, `function f() {`, `m() {`. */
function opensFunction(masked: string, brace: number): boolean {
  const before = masked.slice(0, brace).trimEnd();
  if (before.endsWith('=>')) return true;
  if (!before.endsWith(')')) return false;
  const open = openOf(masked, before.length - 1);
  const word = /([\w$]+)\s*$/.exec(masked.slice(0, Math.max(0, open)))?.[1];
  return word !== undefined && !CONTROL_WORDS.has(word);
}

/** Whether the body opened at `brace` returns a value from its OWN scope, not a nested function's. */
function returnsValue(masked: string, brace: number): boolean {
  const end = closeOf(masked, brace);
  const stack: boolean[] = [];
  for (let index = brace + 1; index < (end < 0 ? masked.length : end); index += 1) {
    const char = masked[index];
    if (char === '{') stack.push(opensFunction(masked, index));
    else if (char === '(' || char === '[') stack.push(false);
    else if (char === '}' || char === ')' || char === ']') stack.pop();
    else if (stack.includes(true) || !masked.startsWith('return', index)) continue;
    else if (/[\w$]/.test(masked[index - 1] ?? '') || /[\w$]/.test(masked[index + 6] ?? '')) {
    } else if (/^[ \t]*[^\s;}]/.test(masked.slice(index + 6))) return true;
  }
  return false;
}

/** Why `masked`'s mount returns no disposer, or `undefined` when it does or none is declared. */
function missingDisposer(masked: string): string | undefined {
  const match = DECLARED.exec(masked) ?? BOUND.exec(masked);
  if (match === null) return undefined;
  const close = closeOf(masked, match.index + match[0].length - 1);
  if (close < 0) return undefined;
  const after = masked.slice(close + 1);
  const arrow = DECLARED.exec(masked) === null;
  const head = arrow ? after.slice(0, Math.max(0, after.indexOf('=>'))) : after.split('{')[0];
  const annotation = (head ?? '').trim();
  if (VOID_ANNOTATION.test(annotation)) return `is typed \`${annotation.slice(1).trim()}\``;
  if (annotation !== '') return undefined;
  const bodyAt = arrow ? close + 1 + after.indexOf('=>') + 2 : close + 1 + after.indexOf('{');
  const lead = masked.slice(bodyAt).match(/^\s*/)?.[0].length ?? 0;
  if (masked[bodyAt + lead] !== '{') return undefined;
  return returnsValue(masked, bodyAt + lead) ? undefined : 'returns nothing from its own body';
}

/** One `X_ISLAND_DISPOSER_MISSING` per `.island.tsx` whose `mount` hands back no disposer. */
export function islandDisposerFindings(files: readonly SourceFile[]): readonly Finding[] {
  return files.flatMap(({ path, source }): Finding[] => {
    if (!path.endsWith(ISLAND_EXTENSION) || !source.includes('mount')) return [];
    const why = missingDisposer(maskLiterals(source));
    if (why === undefined) return [];
    return [
      {
        code: 'X_ISLAND_DISPOSER_MISSING',
        cause: `${path}'s mount() ${why}, so the client router has nothing to call when it navigates away and the island's listeners, hotkeys and live reads stay registered`,
        fix: `x verify --only boundaries --json   # in ${commentSafe(path)}, end mount() with return render(() => <Island {...props} />, el) — Solid's disposer, which the router calls`,
        docs: ERROR_DOCS_URL,
        at: path,
      },
    ];
  });
}
