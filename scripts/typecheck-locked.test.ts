// The root `typecheck` script is the ledgered one: a raw `tsc -b` there would let an agent's compiler
// race the gate's over one `dist/`, with no entry in the machine ledger to explain the memory.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { typecheckArgv } from './typecheck-locked';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · bun run typecheck', () => {
  test('the root script goes through the ledger, and no other script builds', async () => {
    const manifest: { scripts: Record<string, string> } = await Bun.file(
      join(repoRoot(), 'package.json'),
    ).json();
    expect(manifest.scripts['typecheck']).toBe('bun run scripts/typecheck-locked.ts');
    const rawBuilds = Object.entries(manifest.scripts).filter(
      ([, command]) => /\btsc -b\b/.test(command) && !command.includes('--clean'),
    );
    expect(rawBuilds).toEqual([]);
  });

  test('flags reach the compiler after its own', () => {
    expect(typecheckArgv('tsc', ['--force'])).toEqual(['tsc', '-b', '--pretty', '--force']);
  });
});
