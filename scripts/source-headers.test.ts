// The enforcement half of `scripts/source-headers.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a new header violation fails `bun run verify`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { readSourceHeader, sourceHeaderFindings } from './source-headers';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('a source header in the 1–4 line contract', () => {
  test('a one-line header passes', () => {
    expect(readSourceHeader('x.ts', '// The one responsibility.\nexport const a = 1;\n')).toEqual({
      path: 'x.ts',
      lines: ['The one responsibility.'],
    });
  });

  test('a four-line header passes', () => {
    const source = ['// One.', '// Two.', '// Three.', '// Four.', 'export const a = 1;'].join(
      '\n',
    );
    expect(readSourceHeader('x.ts', source).problem).toBeUndefined();
  });

  test('a block header passes', () => {
    const source = ['/**', ' * One responsibility.', ' */', 'export const a = 1;'].join('\n');
    expect(readSourceHeader('x.ts', source).problem).toBeUndefined();
  });

  test('a five-line first paragraph fails', () => {
    const source = ['// One.', '// Two.', '// Three.', '// Four.', '// Five.'].join('\n');
    expect(readSourceHeader('x.ts', source).problem).toBe('too-long');
  });

  test('a missing header fails', () => {
    expect(readSourceHeader('x.ts', 'export const a = 1;\n').problem).toBe('missing');
  });

  test('an empty header fails', () => {
    expect(readSourceHeader('x.ts', '//\nexport const a = 1;\n').problem).toBe('missing');
    expect(readSourceHeader('x.ts', '/**\n */\nexport const a = 1;\n').problem).toBe('empty');
  });
});

describe('the repository tree', () => {
  test('is at or under its per-file pin', async () => {
    const findings = await sourceHeaderFindings(repoRoot());
    expect(findings).toEqual([]);
  });

  test('every finding carries a runnable fix', async () => {
    const findings = await sourceHeaderFindings(repoRoot());
    for (const finding of findings) {
      expect(finding.fix.length).toBeGreaterThan(0);
      expect(finding.fix).toContain('bun run');
    }
  });
});
