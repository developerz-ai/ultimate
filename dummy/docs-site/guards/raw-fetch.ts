// raw-fetch: a server fetch( carries a signal in its own options, or is outbound().
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read: a bare or `globalThis.` `fetch(` call. Not read: an injected `deps.fetch(`, a bare
// `fetch(` in a file that binds its own `fetch` (declared, imported, a parameter, destructured),
// a method DEFINITION (`fetch(request) {`, Bun.serve's handler), a test, or an island (a browser
// has no request to outlive). Options passed as a variable read as unsignalled: spread them and add
// the key.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_RAW_FETCH';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\w$.])(?:globalThis\s*\.\s*)?fetch\s*\(/g;
const SIGNAL = /(?<![\w$.])signal\s*[:,}]/g;

const DECLARED = /\b(?:const|let|var|class|function\s*\*?)\s+([A-Za-z_$][\w$]*)/g;
const ARROW_PARAMETER = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
const IMPORT_CLAUSE = /\bimport\s+([^;]*?)\bfrom\b/g;
/** A name an import clause binds: 'a', '{ a }', '* as a', '{ b as a }', never the 'b' of 'b as a'. */
const IMPORTED = /(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])(?!\s+as\b)/g;
const IDENTIFIER = /(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])/g;
/** After a pattern's closing bracket: '=' closes a destructuring, '=>' or a body a parameter list. */
const PATTERN_END = /^\s*(?::[^=;{}()]*?)?\s*(=>|=(?!=)|\{)/;
const CONDITION = /\b(?:if|for|while|switch|with)\s*$/;
const OPENERS = '([{';
const CLOSERS = ')]}';

/** The index of the bracket closing the one at 'open', or the end of the text. */
const closing = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (OPENERS.includes(text[index] ?? '')) depth += 1;
    if (CLOSERS.includes(text[index] ?? '') && --depth === 0) return index;
  }
  return text.length;
};

/** The brackets enclosing 'at', innermost first, up to and including the first parenthesis. */
const enclosing = (text: string, at: number): readonly number[] => {
  const opens: number[] = [];
  let depth = 0;
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index] ?? '';
    if (CLOSERS.includes(char)) depth += 1;
    else if (OPENERS.includes(char) && depth > 0) depth -= 1;
    else if (OPENERS.includes(char)) {
      opens.push(index);
      if (char === '(') break;
    }
  }
  return opens;
};

/** Whether the occurrence at 'at' sits in a parameter list or a destructuring pattern. */
const inPattern = (text: string, at: number, name: string): boolean => {
  const opens = enclosing(text, at);
  // '{ name: other }' binds 'other', and '(name: Type)' is a parameter: a key only in braces.
  if (text[opens[0] ?? -1] === '{' && /^\s*:/.test(text.slice(at + name.length))) return false;
  for (const open of opens) {
    const close = closing(text, open);
    const end = PATTERN_END.exec(text.slice(close + 1, close + 200))?.[1];
    if (end === undefined) continue;
    if (text[open] !== '(') return end === '=';
    return end !== '=' && !CONDITION.test(text.slice(Math.max(0, open - 10), open));
  }
  return false;
};

/**
 * Whether the file binds 'name' itself (declared, imported, a parameter or destructured), so a
 * bare 'name(' is its own function and not the global. File-wide, not scoped: a guard is a regex.
 */
const bindsLocally = (text: string, name: string): boolean => {
  for (const match of text.matchAll(DECLARED)) if (match[1] === name) return true;
  for (const match of text.matchAll(ARROW_PARAMETER)) if (match[1] === name) return true;
  for (const clause of text.matchAll(IMPORT_CLAUSE)) {
    for (const match of (clause[1] ?? '').matchAll(IMPORTED)) if (match[1] === name) return true;
  }
  for (const match of text.matchAll(IDENTIFIER)) {
    if (match[0] !== name || /^\s*\(/.test(text.slice(match.index + name.length))) continue;
    if (inPattern(text, match.index, name)) return true;
  }
  return false;
};

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (match) =>
      match.replaceAll(/[^\n]/g, ' '),
    );

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The index of the parenthesis closing the one at `open`, or the end of the text. */
const closeOf = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')' && --depth === 0) return index;
  }
  return text.length;
};

/** Whether `signal` is a key of an object at the arguments' TOP level — never `{ env: { signal } }`. */
const hasSignal = (args: string): boolean => {
  for (const match of args.matchAll(SIGNAL)) {
    const opened: string[] = [];
    for (const char of args.slice(0, match.index)) {
      if (char === '{' || char === '[' || char === '(') opened.push(char);
      else if (char === '}' || char === ']' || char === ')') opened.pop();
    }
    if (opened.length === 1 && opened[0] === '{') return true;
  }
  return false;
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawFetches(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    const local = bindsLocally(text, 'fetch');
    for (const match of text.matchAll(CALL)) {
      // A bare call to the file's own `fetch` is an injected client; `globalThis.fetch(` never is.
      if (local && match[0].startsWith('fetch')) continue;
      const open = match.index + match[0].length - 1;
      const close = closeOf(text, open);
      const after = text.slice(close + 1).trimStart();
      // A definition, not a call: a method body or its return type follows the parameter list.
      if (after.startsWith('{') || after.startsWith(':')) continue;
      if (/\bfunction\s*\*?\s*$/.test(text.slice(0, match.index))) continue;
      if (hasSignal(text.slice(open + 1, close))) continue;
      const at = `${file.path}:${lineOf(text, match.index)}`;
      findings.push({
        code: CODE,
        cause: `${at} calls fetch with no signal in its own options, so the call outlives the request that made it: a stalled vendor holds the handler, the drain and a socket`,
        fix: `call outbound({ url, vendor, dial: 'public', deadlineMs: 10_000 }) from @ultimat3/core/outbound in place of the fetch at ${at}, or pass { signal: ctx.signal } in its options — then: x verify`,
        at,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary:
    'a server fetch carries a signal, or is outbound() — never a call that outlives its request',
  async check(_root, sources) {
    // The run's ONE read of the source: every guard asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return rawFetches(
      code
        .filter(
          (file) => !/\.(?:test|d)\.tsx?$/.test(file.path) && !file.path.endsWith('.island.tsx'),
        )
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
