// Pins localBin to a path the host can spawn: the real compiler resolves, a missing tool is named.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no path-join API; the expected fallback is built the way localBin builds it.
import { join } from 'node:path';
import { localBin } from './local-bin';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('localBin', () => {
  test("resolves the repo's own tsc to a file that exists — tsc.exe on Windows", async () => {
    const tsc = localBin(repoRoot(), 'tsc');
    expect(await Bun.file(tsc).exists()).toBe(true);
    expect(tsc.replace(/\.exe$/, '')).toEndWith('tsc');
  });

  test('a tool nobody installed is the path bun install would have written, not a guess', () => {
    const root = repoRoot();
    expect(localBin(root, 'no-such-tool-here')).toBe(
      join(root, 'node_modules', '.bin', 'no-such-tool-here'),
    );
  });

  test('never searches the ambient PATH: a system-wide tool is not the repo’s own', () => {
    // `sh` is on every POSIX PATH and `cmd` on every Windows one; neither is in node_modules/.bin.
    const root = repoRoot();
    const ambient = process.platform === 'win32' ? 'cmd' : 'sh';
    expect(localBin(root, ambient)).toBe(join(root, 'node_modules', '.bin', ambient));
  });
});
