// `x g island --effect`: a closed set of entries, read before a file is planned.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { generate, readEffect } from './generate-files';
import { writeFiles } from './generate-write';
import { loadVersion } from './version-loader';

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

  test('an effect declares @ultimat3/effects in the app manifest; no effect leaves it alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-island-effect-'));
    try {
      const manifest = `${JSON.stringify({ name: 'demo', dependencies: { '@ultimat3/core': '1.0.0', '@ultimat3/entity': '1.0.0' } }, null, 2)}\n`;
      await Bun.write(join(root, 'package.json'), manifest);
      const plain = generate({ kind: 'island', name: 'hero', ...SURFACE });
      expect(plain.some((file) => file.path === 'package.json')).toBe(false);
      const files = generate({ kind: 'island', name: 'hero', effect: 'aurora', ...SURFACE });
      await writeFiles(root, files, false, 'x g', 'hero');
      const written = JSON.parse(await Bun.file(join(root, 'package.json')).text()) as {
        dependencies: Record<string, string>;
      };
      expect(Object.keys(written.dependencies)).toEqual([
        '@ultimat3/core',
        '@ultimat3/effects',
        '@ultimat3/entity',
      ]);
      expect(written.dependencies['@ultimat3/effects']).toBe(loadVersion());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
