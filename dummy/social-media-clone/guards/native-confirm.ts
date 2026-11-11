// native-confirm: a destructive question is a ConfirmDialog, never window.confirm(.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: the browser's confirm box focuses OK, so the Enter that opened it confirms it; it cannot be
// translated, styled or refused, and it blocks the page while it is up. `ConfirmDialog` from
// `@ultimat3/ui` focuses Cancel, posts natively with scripting off and stays open on a refusal.
// Read: a bare, `window.`, `self.` or `globalThis.` `confirm(` in a `*.island.tsx` or anywhere
// under `apps/web/`. Not read: a bare `confirm(` in a file that binds its own `confirm`
// (declared, imported, a parameter, destructured). Admitted: a `// why:` on the line or above it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_NATIVE_CONFIRM';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\w$.])(?<!function\s+)(?:(?:globalThis|window|self)\s*\.\s*)?confirm\s*\(/g;
const WHY = /\/\/\s*why:/;

const DECLARED = /\b(?:const|let|var|class|function\s*\*?)\s+([A-Za-z_$][\w$]*)/g;
const ARROW_PARAMETER = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
const IMPORT_CLAUSE = /\bimport\s+([^;]*?)\bfrom\b/g;
/** A name an import clause binds: 'a', '{ a }', '* as a', '{ b as a }' \u2014 never the 'b' of 'b as a'. */
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
 * Whether the file binds 'name' itself \u2014 declared, imported, a parameter or destructured \u2014 so a
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

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function nativeConfirms(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.source.split('\n');
    const text = blank(file.source);
    const local = bindsLocally(text, 'confirm');
    for (const match of text.matchAll(CALL)) {
      // A bare call to the file's own `confirm` is not the dialog; `window.confirm(` always is.
      if (local && match[0].startsWith('confirm')) continue;
      const line = text.slice(0, match.index).split('\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = `${file.path}:${line}`;
      findings.push({
        code: CODE,
        cause: `${at} asks with confirm(), whose OK holds focus — a stray Enter confirms — and which cannot be translated or refused`,
        fix: `replace the confirm() at ${at} with <ConfirmDialog> from '@ultimat3/ui' (action= for a native post, onConfirm= in an island) — or add a // why: comment on that line naming why it is not a destructive question — then: x verify`,
        at,
      });
    }
  }
  return findings;
}

/** The files the rule reads: islands anywhere, and all of `apps/web/`; never a test. */
export const readsFile = (path: string): boolean =>
  !/\.test\.tsx?$/.test(path) && (path.endsWith('.island.tsx') || path.startsWith('apps/web/'));

export const guard: Guard = {
  summary: 'a destructive question is a ConfirmDialog, never window.confirm()',
  async check(_root, sources) {
    // The run's ONE read of the source: every guard asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return nativeConfirms(
      code
        .filter((file) => readsFile(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
