// The two host-shaped choices the scaffold typecheck makes before it compiles anything: which file
// is the compiler, and which kind of link lends the sandbox the workspace's node_modules.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path-join API; the expected fallback is built the way the harness builds it.
import { join } from 'node:path';
import { DIR_LINK, workspaceRoot, workspaceTsc } from './scaffold-typecheck-fixture';

describe('workspaceTsc', () => {
  test('is a file that exists on this host — tsc.exe on Windows, where no bare tsc is linked', async () => {
    expect(await Bun.file(workspaceTsc(workspaceRoot())).exists()).toBe(true);
  });

  test('a root with no install answers the path bun install would write', () => {
    const root = join(workspaceRoot(), 'no-such-dir');
    expect(workspaceTsc(root)).toBe(join(root, 'node_modules', '.bin', 'tsc'));
  });
});

describe('DIR_LINK', () => {
  test('is a junction on Windows, where a dir symlink needs Developer Mode', () => {
    expect(DIR_LINK).toBe(process.platform === 'win32' ? 'junction' : 'dir');
  });
});
