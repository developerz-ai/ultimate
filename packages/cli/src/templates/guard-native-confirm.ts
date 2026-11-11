// The `native-confirm` guard `x new` ships: no app code asks a destructive question through
// `window.confirm(`. The browser's box holds focus on OK, so a stray Enter confirms; it cannot be
// styled, translated or refused, and it blocks the page. `ConfirmDialog` from `@ultimat3/ui` is the
// one way. A `// why:` on the call's line, or the line above it, admits a call that is not that.

import { guardCode } from './guard';
import { LOCAL_BINDING_SOURCE } from './guard-local-binding';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'native-confirm';
const CODE = guardCode(NAME);

const source =
  (): string => `// native-confirm: a destructive question is a ConfirmDialog, never window.confirm(.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: the browser's confirm box focuses OK, so the Enter that opened it confirms it; it cannot be
// translated, styled or refused, and it blocks the page while it is up. \`ConfirmDialog\` from
// \`@ultimat3/ui\` focuses Cancel, posts natively with scripting off and stays open on a refusal.
// Read: a bare, \`window.\`, \`self.\` or \`globalThis.\` \`confirm(\` in a \`*.island.tsx\` or anywhere
// under \`apps/web/\`. Not read: a bare \`confirm(\` in a file that binds its own \`confirm\`
// (declared, imported, a parameter, destructured). Admitted: a \`// why:\` on the line or above it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\\w$.])(?<!function\\s+)(?:(?:globalThis|window|self)\\s*\\.\\s*)?confirm\\s*\\(/g;
const WHY = /\\/\\/\\s*why:/;

${LOCAL_BINDING_SOURCE}

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`/g, (match) =>
      match.replaceAll(/[^\\n]/g, ' '),
    );

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function nativeConfirms(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.source.split('\\n');
    const text = blank(file.source);
    const local = bindsLocally(text, 'confirm');
    for (const match of text.matchAll(CALL)) {
      // A bare call to the file's own \`confirm\` is not the dialog; \`window.confirm(\` always is.
      if (local && match[0].startsWith('confirm')) continue;
      const line = text.slice(0, match.index).split('\\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = \`\${file.path}:\${line}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} asks with confirm(), whose OK holds focus — a stray Enter confirms — and which cannot be translated or refused\`,
        fix: \`replace the confirm() at \${at} with <ConfirmDialog> from '@ultimat3/ui' (action= for a native post, onConfirm= in an island) — or add a // why: comment on that line naming why it is not a destructive question — then: x verify\`,
        at,
      });
    }
  }
  return findings;
}

/** The files the rule reads: islands anywhere, and all of \`apps/web/\`; never a test. */
export const readsFile = (path: string): boolean =>
  !/\\.test\\.tsx?$/.test(path) && (path.endsWith('.island.tsx') || path.startsWith('apps/web/'));

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
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { nativeConfirms, readsFile } from './native-confirm';

const file = (source: string) => [{ path: 'apps/web/app/posts/delete.island.tsx', source }];

unitTest('a bare confirm( is refused, and the finding names the line', () => {
  const findings = nativeConfirms(file("const a = 1;\\nif (confirm('Delete?')) remove();"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/posts/delete.island.tsx:2');
});

unitTest('window., self. and globalThis. are the same rule', () => {
  expect(nativeConfirms(file("window.confirm('Delete?');"))).toHaveLength(1);
  expect(nativeConfirms(file("self.confirm('Delete?');"))).toHaveLength(1);
  expect(nativeConfirms(file("globalThis.confirm('Delete?');"))).toHaveLength(1);
});

unitTest('a why: on the line or the line above admits it', () => {
  expect(nativeConfirms(file("confirm('Leave?'); // why: an unload prompt"))).toEqual([]);
  expect(nativeConfirms(file("// why: a dev-only reset\\nconfirm('Reset?');"))).toEqual([]);
});

unitTest('a comment, a string, a method and a definition are not calls', () => {
  expect(nativeConfirms(file("// confirm('Delete?');"))).toEqual([]);
  expect(nativeConfirms(file("const s = 'confirm(x)';"))).toEqual([]);
  expect(nativeConfirms(file('dialog.confirm(input);'))).toEqual([]);
  expect(nativeConfirms(file('function confirm(input) { return input; }'))).toEqual([]);
});

unitTest('a confirm the file binds itself is its own; window.confirm( never is', () => {
  expect(nativeConfirms(file('const confirm = async () => {};\\nvoid confirm();'))).toEqual([]);
  expect(nativeConfirms(file('const ask = (confirm) => confirm();'))).toEqual([]);
  expect(nativeConfirms(file("import { confirm } from './x';\\nconfirm('Delete?');"))).toEqual([]);
  expect(nativeConfirms(file("let confirm;\\nwindow.confirm('Delete?');"))).toHaveLength(1);
  expect(nativeConfirms(file("const { confirm: ask } = deps;\\nconfirm('x');"))).toHaveLength(1);
});

unitTest('islands and apps/web are read; tests and other packages are not', () => {
  expect(readsFile('apps/web/app/posts/page.tsx')).toBe(true);
  expect(readsFile('packages/ui/src/delete.island.tsx')).toBe(true);
  expect(readsFile('apps/web/app/posts/page.test.ts')).toBe(false);
  expect(readsFile('packages/domain/src/rules.ts')).toBe(false);
});
`;

/** `guards/native-confirm.ts` and its test. No index, no registry — the directory registers it. */
export const nativeConfirmGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
