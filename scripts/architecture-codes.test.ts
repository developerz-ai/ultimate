// Every X_* code `docs/architecture/` names is one a reader can look up: a row in
// `wiki/Error-Codes.md` (registered or reserved — the `errors` step holds the rows to the
// registries), a code a tracked app owns, or a placeholder this file names with its reason. The
// doc named two codes nothing raised (plan 101 19b, Y10); this is what makes the third a red test.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

const ROOT = `${import.meta.dir}/..`;

/** Spelled in prose as a pattern or an instruction, never a code anything raises. */
const NOT_CODES: Readonly<Record<string, string>> = {
  X_SCREAMING_SNAKE: 'the shape every code takes',
  X_PKG_WHAT_FAILED: "new-error-code's placeholder argument",
  X_YOUR_CODE: "registerErrorRetry's placeholder argument",
  X_QUERY_UNBOUNDED: 'named to say no such code exists',
  X_CREDENTIALS_INVALID: "an app's own code in a registerErrorStatus example",
  X_SIGNUP_CLOSED: "an app's own code in a registerErrorStatus example",
};

const CODE = /\bX_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g;
/** `X_BOUNDARY_*`: a family named by its prefix, not a code. */
const isPrefix = (text: string, end: number): boolean => text[end] === '_';

/** Every code a page names, with the first `path:line` that names it. */
export function namedCodes(files: readonly { path: string; text: string }[]): Map<string, string> {
  const named = new Map<string, string>();
  for (const { path, text } of files) {
    for (const match of text.matchAll(CODE)) {
      if (isPrefix(text, match.index + match[0].length) || named.has(match[0])) continue;
      const line = text.slice(0, match.index).split('\n').length;
      named.set(match[0], `${path}:${line}`);
    }
  }
  return named;
}

/** The codes a reader finds a row for: each backticked code in a table row's first cell. */
export function wikiCodes(text: string): Set<string> {
  const cells = [...text.matchAll(/^\| ([^|]*`X_[^|]*)\|/gm)].map((m) => m[1] ?? '');
  return new Set(
    cells.flatMap((cell) => [...cell.matchAll(/`(X_[A-Z0-9_]+)`/g)].map((m) => m[1] ?? '')),
  );
}

async function read(pattern: string, cwd: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Glob(pattern).scan({ cwd })) {
    if (path.includes('node_modules/') || path.includes('/dist/')) continue;
    files.push({ path, text: await Bun.file(`${cwd}/${path}`).text() });
  }
  return files;
}

/** Codes the tracked apps raise or guard with: written as a string literal in their sources. */
async function appCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const app of ['examples/dummy', 'dummy/social-media-clone', 'dummy/docs-site']) {
    for (const { text } of await read('{apps,guards,packages}/**/*.{ts,tsx}', `${ROOT}/${app}`)) {
      for (const m of text.matchAll(/['"`](X_[A-Z0-9_]+)['"`]/g)) codes.add(m[1] ?? '');
    }
  }
  return codes;
}

describe('unit · the codes docs/architecture/ names', () => {
  test('a code, a prefix and a repeat are told apart', () => {
    const named = namedCodes([
      { path: 'a.md', text: '`X_ONE` and `X_BOUNDARY_*`\nthen `X_ONE` again and X_TWO.' },
    ]);
    expect([...named]).toEqual([
      ['X_ONE', 'a.md:1'],
      ['X_TWO', 'a.md:2'],
    ]);
    expect(wikiCodes('| `X_ONE` / `X_TWO` | title |\n| X_SIX | no backticks |')).toEqual(
      new Set(['X_ONE', 'X_TWO']),
    );
  });

  test('every one has a row in wiki/Error-Codes.md, an owning app, or a stated reason', async () => {
    const pages = await read('*.md', `${ROOT}/docs/architecture`);
    const listed = wikiCodes(await Bun.file(`${ROOT}/wiki/Error-Codes.md`).text());
    const owned = await appCodes();
    const unknown = [...namedCodes(pages)]
      .filter(([code]) => !listed.has(code) && !owned.has(code) && !(code in NOT_CODES))
      .map(([code, at]) => `${at} ${code}`);
    // Register it (`bun run new-error-code`), or correct the page to the code that is raised.
    expect(unknown).toEqual([]);
  });

  test('every stated reason is still needed', async () => {
    const named = namedCodes(await read('*.md', `${ROOT}/docs/architecture`));
    expect(Object.keys(NOT_CODES).filter((code) => !named.has(code))).toEqual([]);
  });
});
