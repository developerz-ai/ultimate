// The path half of the error contract, over a repo: `checkErrorFixes` walking real files, which is
// the only place the rule's THREE narrowings can be seen taking effect. Its own file because
// `error-contract.test.ts` reached the 500-line ceiling, and "is this fix an instruction" and "does
// the file it names exist" are two questions. The rule's own unit is `fix-path.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no temp-directory and no recursive remove, and each case needs its own
// root; `join` because Bun exposes no path-join primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { checkErrorFixes } from './error-contract';

describe('the path rule, over a repo', () => {
  let root = '';

  const write = async (path: string, text: string): Promise<void> => {
    // `Bun.write` creates the intermediate directories, so it is this repo's `mkdir -p` too.
    await Bun.write(join(root, path), text);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'error-contract-paths-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The third rule, and the one nothing enforced: a file token is what makes a `fix:` an
  // instruction, and until 2026-08 no check ever asked whether the file was there.
  test('a fix citing a path this repo does not have is a finding of its own', async () => {
    await write(
      'packages/db/src/thing.ts',
      "throw new E({ fix: 'open packages/db/src/gone.ts' });\n",
    );
    const [finding, ...rest] = await checkErrorFixes(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_FIX_PATH_MISSING');
    expect(finding?.at).toBe('packages/db/src/thing.ts:1');
    expect(finding?.cause).toContain('packages/db/src/gone.ts');
    expect(finding?.fix).toContain('correct the path in the fix at packages/db/src/thing.ts:1');
  });

  test('a fix citing a path this repo does have is clean', async () => {
    await write('packages/db/src/here.ts', 'export const here = 1;\n');
    await write(
      'packages/db/src/thing.ts',
      "throw new E({ fix: 'open packages/db/src/here.ts' });\n",
    );
    expect(await checkErrorFixes(root)).toEqual([]);
  });

  // The narrowing that keeps the finding unarguable: a framework error legitimately names a path
  // in the READER's app, and no root the gate runs in can resolve one.
  test('a path whose directory this repo does not have is not judged at all', async () => {
    await write(
      'packages/db/src/thing.ts',
      "throw new E({ fix: 'register it in src/errors.ts, or open apps/web/server.ts' });\n",
    );
    expect(await checkErrorFixes(root)).toEqual([]);
  });
});
