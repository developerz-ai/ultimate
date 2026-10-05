// The live-suite hint names a command the contributor's own shell can run.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no path-join API; the real env file is opened under the checkout.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { liveSuiteLines, TEST_SERVICES_ENV } from './test-services-hint';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('liveSuiteLines', () => {
  test('POSIX gets the bash export it always got', () => {
    expect(liveSuiteLines('linux').at(-1)).toBe(`    set -a; . ${TEST_SERVICES_ENV}; set +a`);
  });

  test('Windows gets PowerShell, with no bash syntax in it', () => {
    const load = liveSuiteLines('win32').at(-1) ?? '';
    expect(load).toContain('Set-Item "env:$k" $v');
    expect(load).toContain(TEST_SERVICES_ENV);
    expect(load).not.toContain('set -a');
  });

  test('the PowerShell loader yields what the bash one does for the real file', async () => {
    // The loader's logic, applied in TS: lines starting `[A-Z]`, split on the FIRST `=`.
    const text = await Bun.file(join(repoRoot(), TEST_SERVICES_ENV)).text();
    const loaded = text
      .split(/\r?\n/)
      .filter((line) => /^[A-Z]/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
    expect(loaded.length).toBeGreaterThan(0);
    for (const [name, value] of loaded) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(value).not.toBe('');
    }
  });
});
