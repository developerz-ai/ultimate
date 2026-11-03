// The `raw-fetch` guard `x new` ships: a server `fetch(` carries a signal in its own options, or is
// `outbound()` from `@ultimat3/core/outbound`. A fetch with no signal outlives the request that made
// it — a stalled vendor holds the handler, the drain and a socket for as long as it likes. With a
// signal it stays legal: the guard cannot prove the other properties, and outbound() is the way.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-fetch';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-fetch: a server fetch( carries a signal in its own options, or is outbound().
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read: a bare or \`globalThis.\` \`fetch(\` call. Not read: an injected \`deps.fetch(\`, a method
// DEFINITION (\`fetch(request) {\`, Bun.serve's handler), a test, or an island (a browser has no
// request to outlive). Options passed as a variable read as unsignalled: spread them and add the key.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\\w$.])(?:globalThis\\s*\\.\\s*)?fetch\\s*\\(/g;
const SIGNAL = /(?<![\\w$.])signal\\s*[:,}]/g;

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`/g, (match) =>
      match.replaceAll(/[^\\n]/g, ' '),
    );

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** The index of the parenthesis closing the one at \`open\`, or the end of the text. */
const closeOf = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')' && --depth === 0) return index;
  }
  return text.length;
};

/** Whether \`signal\` is a key of an object at the arguments' TOP level — never \`{ env: { signal } }\`. */
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
    for (const match of text.matchAll(CALL)) {
      const open = match.index + match[0].length - 1;
      const close = closeOf(text, open);
      const after = text.slice(close + 1).trimStart();
      // A definition, not a call: a method body or its return type follows the parameter list.
      if (after.startsWith('{') || after.startsWith(':')) continue;
      if (/\\bfunction\\s*\\*?\\s*$/.test(text.slice(0, match.index))) continue;
      if (hasSignal(text.slice(open + 1, close))) continue;
      const at = \`\${file.path}:\${lineOf(text, match.index)}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} calls fetch with no signal in its own options, so the call outlives the request that made it: a stalled vendor holds the handler, the drain and a socket\`,
        fix: \`call outbound({ url, vendor, dial: 'public', deadlineMs: 10_000 }) from @ultimat3/core/outbound in place of the fetch at \${at}, or pass { signal: ctx.signal } in its options — then: x verify\`,
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
          (file) => !/\\.(?:test|d)\\.tsx?$/.test(file.path) && !file.path.endsWith('.island.tsx'),
        )
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawFetches } from './raw-fetch';

const file = (source: string) => [{ path: 'apps/web/app/post/repo.ts', source }];

unitTest('a bare fetch is refused, and the finding names the line', () => {
  const findings = rawFetches(file('const a = 1;\\nconst r = await fetch(url);'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/post/repo.ts:2');
});

unitTest('globalThis.fetch and a signal nested in another key are the same rule', () => {
  expect(rawFetches(file('await globalThis.fetch(url, { method: "POST" });'))).toHaveLength(1);
  expect(rawFetches(file('await fetch(url, { env: { signal } });'))).toHaveLength(1);
  expect(rawFetches(file('await fetch(url, init);'))).toHaveLength(1);
});

unitTest('a signal in its own options is what the rule asks for', () => {
  expect(rawFetches(file('await fetch(url, { signal });'))).toEqual([]);
  expect(rawFetches(file('await fetch(url, { method: "GET", signal: ctx.signal });'))).toEqual([]);
});

unitTest('an injected fetch, a handler definition and a comment are not calls', () => {
  expect(rawFetches(file('await deps.fetch(url);'))).toEqual([]);
  expect(rawFetches(file('Bun.serve({ fetch(request) { return new Response(); } });'))).toEqual([]);
  expect(rawFetches(file('// await fetch(url);'))).toEqual([]);
  expect(rawFetches(file("const s = 'fetch(url)';"))).toEqual([]);
});
`;

/** `guards/raw-fetch.ts` and its test. No index, no registry — the directory registers it. */
export const rawFetchGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
