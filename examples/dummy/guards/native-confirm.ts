// native-confirm: a destructive question is a ConfirmDialog, never window.confirm(.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: the browser's confirm box focuses OK, so the Enter that opened it confirms it; it cannot be
// translated, styled or refused, and it blocks the page while it is up. `ConfirmDialog` from
// `@ultimat3/ui` focuses Cancel, posts natively with scripting off and stays open on a refusal.
// Read: a bare, `window.`, `self.` or `globalThis.` `confirm(` in a `*.island.tsx` or anywhere
// under `apps/web/`. Admitted: a `// why:` on the call's line or the line above it.

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
    for (const match of text.matchAll(CALL)) {
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
