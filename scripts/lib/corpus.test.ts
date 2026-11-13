// The `tests` scope is every test file a guard over tests must read. It globbed `src/` and
// `scripts/` only, so the fifteen suites under `packages/*/e2e/` were invisible to
// `test-bare-error` and `test-fix-citations` — each answered green over files it never opened.

import { describe, expect, test } from 'bun:test';
import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import { checkBoundaries } from '../boundaries';
import { catchRenderSites } from '../catch-render';
import { checkErrorRendering } from '../error-render';
import { fixParamsOf, scanFixShellArgs } from '../fix-shell-arg';
import { keyedHasherResult } from '../keyed-hasher';
import { sealCalls } from '../seal-calls';
import { scanBareErrorThrows } from '../test-bare-error';
import type { CorpusFile } from './corpus';
import { CORPUS_PATTERNS, CORPUS_READ_BATCH, corpus, corpusFile } from './corpus';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

test(
  'the tests scope reads the e2e suites, and only test files from them',
  async () => {
    const paths = (await corpus(repoRoot(), 'tests')).map((file) => file.path);
    const e2e = paths.filter((path) => /^packages\/[^/]+\/e2e\//.test(path));
    expect(e2e.length).toBeGreaterThan(0);
    // `client-navigation-fixture.ts` sits beside them and is not a suite.
    expect(e2e.every((path) => /\.test\.tsx?$/.test(path))).toBe(true);
  },
  REPO_SCAN_TIMEOUT_MS,
);

test('source already reads e2e, so the two scopes agree on where tests live', () => {
  expect(CORPUS_PATTERNS.source).toContain('packages/*/e2e/**/*.{ts,tsx}');
  expect(CORPUS_PATTERNS.tests).toContain('packages/*/e2e/**/*.test.{ts,tsx}');
});

test(
  'a scope larger than one read batch comes back whole, each file beside its own path',
  async () => {
    const files = await corpus(repoRoot(), 'shipped');
    // The repository is many batches; a batch boundary that shifted the texts would pair a path
    // with its neighbour's source.
    expect(files.length).toBeGreaterThan(CORPUS_READ_BATCH * 4);
    for (const at of [0, CORPUS_READ_BATCH - 1, CORPUS_READ_BATCH, files.length - 1]) {
      const file = files[at];
      if (file === undefined) return expect.unreachable('the index is inside the scope');
      expect(file.source).toBe(await Bun.file(`${repoRoot()}/${file.path}`).text());
    }
  },
  REPO_SCAN_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------------------------
// One mask per file per process. Each text rule on the gate reads `file.masked`/`file.stripped`
// off the corpus object instead of masking for itself, and skips a file its prefilter clears
// without reading either. The masks below count; the planted file per rule proves the prefilter
// kept what it must.
// ---------------------------------------------------------------------------------------------

/** A unique tail per run: `maskToCode` and core's mask memoise on text, and a hit masks nothing. */
const RUN = `\n// ${crypto.randomUUID()}\n`;

/** Every planted file: one finding per rule, each through that rule's own prefilter. */
const PLANTED: Readonly<Record<string, string>> = {
  'packages/core/src/tier.ts':
    "import { render } from '@ultimat3/render';\nexport const r = render;\n",
  'packages/core/src/climb.ts': "import { x } from '.././../cli/src/x';\nexport const y = x;\n",
  'packages/auth/src/hash.ts':
    "export const h = (key: string) => new Bun.CryptoHasher('sha256', key);\n",
  'packages/auth/src/seal.ts':
    'export const s = (k: CryptoKey, d: Uint8Array) => crypto.subtle.encrypt(ALG, k, d);\n',
  'packages/x/src/render.ts':
    // `$` + `{` apart, so this file's own template rule reads a string, not a placeholder.
    `export function f(value: unknown) {\n  return new E({ cause: \`bad $${'{'}value}\`, fix: 'x' });\n}\n`,
  'packages/x/src/caught.ts':
    "export function g() {\n  try { h(); } catch (error) {\n    throw new E({ cause: String(error), fix: 'x' });\n  }\n}\n",
  'packages/x/src/shell.ts': `export const k = (name: string) => ({ fix: \`rm -rf $${'{'}name}\` });\n`,
  'packages/x/src/thrown.ts': "export const t = () => {\n  throw new Error('bare');\n};\n",
  // Clears every prefilter: no rule may mask it.
  'packages/x/src/plain.ts': 'export const plain = 1;\n',
};

function plantedCorpus(): {
  readonly files: readonly CorpusFile[];
  readonly calls: ReadonlyMap<string, number>;
} {
  const calls = new Map<string, number>();
  const files = Object.entries(PLANTED).map(([path, text]) => {
    const count = (kind: string, real: (source: string) => string) => (source: string) => {
      calls.set(`${kind}:${path}`, (calls.get(`${kind}:${path}`) ?? 0) + 1);
      return real(source);
    };
    return corpusFile(path, text + RUN, {
      mask: count('mask', maskLiterals),
      strip: count('strip', stripComments),
    });
  });
  return { files, calls };
}

describe('every text rule masks a corpus file at most once', () => {
  test('a corpus file computes each mask on first read and never again', () => {
    let masks = 0;
    let strips = 0;
    const file = corpusFile('packages/x/src/a.ts', 'const a = "b"; // c\n', {
      mask: (source) => {
        masks += 1;
        return maskLiterals(source);
      },
      strip: (source) => {
        strips += 1;
        return stripComments(source);
      },
    });
    expect([masks, strips]).toEqual([0, 0]);
    for (let read = 0; read < 3; read += 1) {
      expect(file.masked).toBe(maskLiterals(file.source));
      expect(file.stripped).toBe(stripComments(file.source));
    }
    expect([masks, strips]).toEqual([1, 1]);
  });

  test(
    "this repository's scopes are the same objects on every call, so the memo spans the process",
    async () => {
      const [first, second] = await Promise.all([
        corpus(repoRoot(), 'shipped'),
        corpus(repoRoot(), 'shipped'),
      ]);
      expect(second).toBe(first);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('every rule finds its planted file, and no file is masked twice or a cleared one at all', () => {
    const { files, calls } = plantedCorpus();
    const at = (path: string): CorpusFile =>
      files.find((file) => file.path === path) ?? expect.unreachable(`${path} is planted`);
    expect(checkBoundaries(files).map((one) => one.file)).toEqual([
      'packages/core/src/tier.ts',
      'packages/core/src/climb.ts',
    ]);
    expect(keyedHasherResult(files).findings?.map((one) => one.code)).toContain('X_KEYED_HASHER');
    expect(files.flatMap(sealCalls).map((one) => one.file)).toEqual(['packages/auth/src/seal.ts']);
    expect(checkErrorRendering(files).map((one) => one.file)).toEqual(['packages/x/src/render.ts']);
    expect(catchRenderSites(files).map((one) => one.path)).toEqual(['packages/x/src/caught.ts']);
    const params = fixParamsOf(
      files.map((file) => file.source),
      files,
    );
    const shell = files.flatMap((file) => scanFixShellArgs(file.path, file.source, params, file));
    expect(shell.map((one) => one.path)).toContain('packages/x/src/shell.ts');
    const thrown = files.flatMap((file) => scanBareErrorThrows(file.path, file.source, file));
    expect(thrown.map((one) => one.path)).toEqual(['packages/x/src/thrown.ts']);
    // A second pass over the same objects asks again, and is answered from the object.
    checkErrorRendering(files);
    keyedHasherResult(files);
    for (const [key, count] of calls) expect(`${key} ${count}`).toBe(`${key} 1`);
    expect(calls.has(`mask:${at('packages/x/src/plain.ts').path}`)).toBe(false);
    expect(calls.has(`strip:${at('packages/x/src/plain.ts').path}`)).toBe(false);
  });

  test('a rule reads the mask the corpus file hands it, never one of its own', () => {
    // An identity "mask" leaves a string's text visible: a rule that read the file's own mask
    // reports the call inside the string, and one that re-masked the source would not.
    const raw = (path: string, source: string): CorpusFile =>
      corpusFile(path, source, { mask: (text) => text, strip: (text) => text });
    const hasher = raw(
      'packages/auth/src/a.ts',
      'const s = "new Bun.CryptoHasher(\'sha256\', k)";\n',
    );
    expect(keyedHasherResult([hasher]).findings?.map((one) => one.code)).toContain(
      'X_KEYED_HASHER',
    );
    const thrown = raw('packages/x/src/b.ts', 'const s = "throw new Error(\'x\')";\n');
    expect(scanBareErrorThrows(thrown.path, thrown.source, thrown)).toHaveLength(1);
    const sealed = raw('packages/auth/src/c.ts', 'const s = "crypto.subtle.encrypt(a, k, d)";\n');
    expect(sealCalls(sealed)).toHaveLength(1);
  });
});
