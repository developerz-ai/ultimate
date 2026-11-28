// `x g island --effect`: a closed set of entries, read before a file is planned.

import { describe, expect, test } from 'bun:test';
import { generate, readEffect } from './generate-files';

const SURFACE = { surface: 'site', feature: 'home' } as const;

describe('unit · x g island --effect', () => {
  test('an entry that wraps a panel is accepted, and the island names it', () => {
    expect(readEffect('aurora', 'island')).toBe('aurora');
    const files = generate({ kind: 'island', name: 'hero', effect: 'aurora', ...SURFACE });
    const island = files.find((file) => file.path.endsWith('hero.island.tsx'));
    expect(String(island?.contents)).toContain('Aurora');
    const plain = generate({ kind: 'island', name: 'hero', ...SURFACE });
    expect(String(plain.find((f) => f.path.endsWith('hero.island.tsx'))?.contents)).not.toContain(
      '@ultimat3/effects',
    );
  });

  test('no flag is no effect', () => {
    expect(readEffect(undefined, 'island')).toBeUndefined();
  });

  test('a value outside the set is X_CLI_BAD_FLAG with the entries named', () => {
    expect(() => readEffect('confetti', 'island')).toThrow(/aurora/);
    try {
      readEffect('confetti', 'island');
      expect.unreachable('refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_CLI_BAD_FLAG');
    }
  });

  test('a kind with no panel refuses the flag rather than ignoring it', () => {
    expect(() => readEffect('aurora', 'route')).toThrow(/only an island/);
  });
});
