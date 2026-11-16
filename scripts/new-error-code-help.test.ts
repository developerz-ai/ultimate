// `--help` and `-h` print the usage of both modes and exit 0, as text and as `--json`; before this
// file they were refused as unknown flags with X_NEW_ERROR_CODE_INVALID.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { NEW_ERROR_CODE_USAGE, wantsHelp } from './new-error-code-help';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const help = (...args: string[]) =>
  run(['bun', 'run', 'scripts/new-error-code.ts', ...args], { cwd: repoRoot() });

describe('new-error-code --help', () => {
  for (const flag of ['--help', '-h']) {
    test(`${flag} prints both modes and exits 0`, async () => {
      const answer = await help(flag);
      expect(answer.code).toBe(0);
      expect(answer.output).toContain('--package <pkg>');
      expect(answer.output).toContain('--script scripts/<file>.ts');
      expect(answer.output).not.toContain('X_NEW_ERROR_CODE_INVALID');
    });
  }

  test('--help --json is one document carrying the usage', async () => {
    const answer = await help('--help', '--json');
    expect(answer.code).toBe(0);
    const parsed: unknown = JSON.parse(answer.output);
    expect(parsed).toMatchObject({ ok: true, data: { usage: [...NEW_ERROR_CODE_USAGE] } });
  });

  test('wantsHelp reads --help and -h only', () => {
    expect(wantsHelp(['X_A', '--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['X_A', '--title', 'help'])).toBe(false);
    // A VALUE is not a request: `--fix -h` documents a fix that is `-h`, and must still write.
    expect(wantsHelp(['X_A', '--fix', '-h'])).toBe(false);
    expect(wantsHelp(['X_A', '--title', '--help'])).toBe(false);
    expect(wantsHelp(['X_A', '--dry-run', '-h'])).toBe(true);
  });
});
