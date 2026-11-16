// The enforcement half of `scripts/source-headers.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a new header violation fails `bun run verify`.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own.
import { tmpdir } from 'node:os';
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

describe('an inline block header', () => {
  test('a one-line block header passes', () => {
    expect(readSourceHeader('x.ts', '/* One responsibility. */\nexport const a = 1;\n')).toEqual({
      path: 'x.ts',
      lines: ['One responsibility.'],
    });
  });

  test('a one-line JSDoc header passes', () => {
    expect(readSourceHeader('x.ts', '/** One responsibility. */\nexport const a = 1;\n')).toEqual({
      path: 'x.ts',
      lines: ['One responsibility.'],
    });
  });

  test('code after the closing delimiter is not prose', () => {
    expect(
      readSourceHeader('x.ts', '/* One responsibility. */ export const a = 1;\n').lines,
    ).toEqual(['One responsibility.']);
  });

  test('prose on the opening delimiter line counts', () => {
    const source = ['/* One responsibility,', ' * carried on.', ' */', 'export const a = 1;'].join(
      '\n',
    );
    expect(readSourceHeader('x.ts', source).lines).toEqual(['One responsibility,', 'carried on.']);
  });

  test('prose before the closing delimiter counts', () => {
    const source = [
      '/*',
      ' * One responsibility,',
      ' * stated here. */',
      'export const a = 1;',
    ].join('\n');
    expect(readSourceHeader('x.ts', source).lines).toEqual(['One responsibility,', 'stated here.']);
  });

  test('delimiter-line prose counts toward the four-line contract', () => {
    const source = ['/* One.', ' * Two.', ' * Three.', ' * Four.', ' * Five.', ' */'].join('\n');
    expect(readSourceHeader('x.ts', source).problem).toBe('too-long');
  });

  test('a bare one-line delimiter is still empty', () => {
    expect(readSourceHeader('x.ts', '/* */\nexport const a = 1;\n').problem).toBe('empty');
    expect(readSourceHeader('x.ts', '/***/\nexport const a = 1;\n').problem).toBe('empty');
  });

  test('a blank line still ends the first paragraph', () => {
    const source = ['/*', ' * One responsibility.', ' *', ' * Why: longer.', ' */'].join('\n');
    expect(readSourceHeader('x.ts', source).lines).toEqual(['One responsibility.']);
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

describe('a fixture tree', () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test('each violation is its own finding, and a pinned file under its pin is a stale row', async () => {
    const root = await mkdtemp(`${tmpdir()}/source-headers-`);
    made.push(root);
    const five = Array.from({ length: 5 }, (_, i) => `// line ${String(i)} of prose.`).join('\n');
    await Bun.write(`${root}/packages/demo/src/ok.ts`, '// Owns one thing.\nexport const a = 1;\n');
    await Bun.write(`${root}/packages/demo/src/bare.ts`, 'export const b = 1;\n');
    await Bun.write(`${root}/packages/demo/src/empty.ts`, '/* */\nexport const c = 1;\n');
    await Bun.write(`${root}/packages/demo/src/long.ts`, `${five}\nexport const d = 1;\n`);
    // A pinned path, present and clean: its pin outlived its violation.
    await Bun.write(`${root}/packages/i18n/src/subset.ts`, '// Owns one thing.\nexport {};\n');

    const findings = await sourceHeaderFindings(root, {
      'packages/i18n/src/subset.ts': { count: 1, reason: 'fixture row' },
    });
    const byAt = new Map(findings.map((finding) => [finding.at, finding]));
    expect(byAt.get('packages/demo/src/bare.ts')?.code).toBe('X_SOURCE_HEADER_MISSING');
    expect(byAt.get('packages/demo/src/empty.ts')?.cause).toContain('empty header comment');
    expect(byAt.get('packages/demo/src/long.ts')?.cause).toContain('5-line first paragraph');
    expect(byAt.has('packages/demo/src/ok.ts')).toBe(false);
    const stale = findings.find((finding) => finding.code === 'X_SOURCE_HEADER_PIN_STALE');
    expect(stale?.cause).toContain('packages/i18n/src/subset.ts is pinned at 1');
    expect(findings).toHaveLength(4);
  });
});
