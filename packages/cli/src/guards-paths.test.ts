// `guards/` is a directory or absent; a FILE named `guards` is neither, and must not crash the
// `boundaries` step or `x doctor` with ENOTDIR: no guards to list, and the gate says why.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { shippedGuardsProbe } from './doctor-guards';
import { guardReport } from './guards';
import { guardPaths } from './guards-paths';

const withGuardsFile = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guards-file-'));
  try {
    await Bun.write(join(root, 'guards'), 'not a directory\n');
    await Bun.write(join(root, 'package.json'), JSON.stringify({ engines: { bun: '1.4.4' } }));
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · a file named guards', () => {
  test('lists no guards, and x doctor probes it without a throw', async () => {
    await withGuardsFile(async (root) => {
      expect(await guardPaths(root)).toEqual([]);
      expect(await shippedGuardsProbe(root)).toEqual([]);
    });
  });

  test('the boundaries step reports it, never crashes on it', async () => {
    await withGuardsFile(async (root) => {
      const { findings } = await guardReport(root);
      expect(findings.map(({ code }) => code)).toEqual(['X_GUARD_INVALID']);
      expect(findings[0]?.at).toBe('guards');
      expect(findings[0]?.cause).toContain('not a directory');
    });
  });
});
