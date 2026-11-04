// The refusal the image build hits when the flag is missing. It lived in an `import.meta.main`
// block, so the line that answered it ran only as a process and every line of the command
// counted as uncovered: a command nothing could exercise was a command nothing had proved.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { compileX } from './compile-x';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · compile-x refuses a compile with no destination', () => {
  test('no --outfile is X_CONFIG_INVALID, naming the command that takes one', async () => {
    const result = await compileX({ outfile: undefined, root: repoRoot() });

    expect(result.ok).toBe(false);
    expect(result.script).toBe('compile-x');
    expect(result.summary).toBe('--outfile is required');
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.code).toBe('X_CONFIG_INVALID');
    expect(result.findings?.[0]?.cause).toBe('compile-x writes one binary and was not told where');
    expect(result.findings?.[0]?.fix).toBe('bun run scripts/compile-x.ts --outfile /out/app');
  });
});
