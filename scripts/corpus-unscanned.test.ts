// No guard answers "clean" over a tree it could not read. Every whole-tree guard reads through
// `scripts/lib/corpus.ts`, and a root whose `packages/` is unreadable must come back as
// `X_CORPUS_UNSCANNED` from every one of them — never an empty finding list, which is exactly what
// a clean tree returns.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent — `mkdtemp`/`rm`/`chmod` own a fixture root whose
// `packages/` the scan is refused permission to read.
import { chmod, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { catchRenderFindings } from './catch-render';
import { configReaderInput } from './config-readers';
import { deadHostFindings } from './dead-docs-host';
import { declarationReaderInput } from './declaration-readers';
import { errorRendering } from './error-render';
import { finiteBoundFindings } from './finite-bounds';
import { fixShellArgFindings } from './fix-shell-arg';
import { flightCopyFindings } from './flight-copies';
import { frozenRecordReport } from './frozen-records';
import { CORPUS_FLOORS, corpus } from './lib/corpus';
import { scanFrameworkCatalogSources } from './lib/i18n-scan';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { nodeImportFindings } from './node-imports';
import { protoIndexFindings } from './proto-index';
import { vocabularyFindings } from './render-modes';
import { secretCompareFindings } from './secret-compare';
import { bareErrorFindings } from './test-bare-error';
import { testFixFindings } from './test-fix-citations';
import { tierBoundaries } from './verify';

/** Every guard that reads the tree, by the name its `bun run` alias carries. */
const GUARDS: readonly (readonly [string, (root: string) => Promise<unknown>])[] = [
  ['boundaries', tierBoundaries],
  ['catch-render', catchRenderFindings],
  ['config-readers', configReaderInput],
  ['dead-docs-host', deadHostFindings],
  ['declaration-readers', declarationReaderInput],
  ['error-render', errorRendering],
  ['finite-bounds', finiteBoundFindings],
  ['fix-shell-arg', fixShellArgFindings],
  ['flight-copies', flightCopyFindings],
  ['frozen-records', frozenRecordReport],
  ['i18n-catalog', scanFrameworkCatalogSources],
  ['node-imports', nodeImportFindings],
  ['proto-index', protoIndexFindings],
  ['render-modes', vocabularyFindings],
  ['secret-compare', secretCompareFindings],
  ['test-bare-error', bareErrorFindings],
  ['test-fix-citations', testFixFindings],
];

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  }
  return 'answered';
};

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-corpus-unscanned-'));
  await Bun.write(join(root, 'packages/core/src/index.ts'), 'export const a = 1;\n');
  await Bun.write(join(root, 'scripts/x.test.ts'), 'export {};\n');
  await chmod(join(root, 'packages'), 0o000);
});

afterAll(async () => {
  await chmod(join(root, 'packages'), 0o755);
  await rm(root, { recursive: true, force: true });
});

describe('unit · a guard over an unreadable tree refuses, never answers clean', () => {
  test.each(GUARDS.map(([name, run]) => [name, run] as const))(
    '%s answers X_CORPUS_UNSCANNED',
    async (_name, run) => {
      expect(await codeOf(() => run(root))).toBe('X_CORPUS_UNSCANNED');
    },
  );

  test('a readable fixture root with one file answers; the floor is only this repo`s', async () => {
    const readable = await mkdtemp(join(tmpdir(), 'ultimate-corpus-one-'));
    try {
      await Bun.write(join(readable, 'packages/core/src/index.ts'), 'export const a = 1;\n');
      expect((await corpus(readable, 'shipped')).map((file) => file.path)).toEqual([
        'packages/core/src/index.ts',
      ]);
    } finally {
      await rm(readable, { recursive: true, force: true });
    }
  });

  test(
    'this repo clears every floor, and the scopes are read once per process',
    async () => {
      for (const scope of ['source', 'packages', 'shipped', 'tests'] as const) {
        const files = await corpus(repoRoot(), scope);
        expect(files.length).toBeGreaterThanOrEqual(CORPUS_FLOORS[scope]);
        expect(await corpus(repoRoot(), scope)).toBe(files);
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
