// The codes a built-in guard raises are the app's contract as much as a vendored copy's were: they
// are codes its gate emits. So `x.manifest.json`'s `errorCodes` lists every built-in that runs, and
// deleting the copies (`vendored-guards`) removes no code — `contract-diff` stays green.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { SHIPPED_GUARD_CONFIG } from './guards-built-in';
import { builtInGuardCodes, withBuiltInGuardCodes } from './guards-built-in-codes';
import {
  SHIPPED_GUARD_NAMES as SHIPPED_GUARD_NAMES_LEAF,
  shippedGuardCode,
} from './guards-shipped-names';
import { guardCode } from './templates/guard';
import { SHIPPED_GUARD_NAMES, shippedGuardSource } from './templates/scaffold-guards';

const withApp = async (
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guard-codes-'));
  try {
    for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · the manifest lists the codes of every built-in guard that runs', () => {
  test('every shipped guard, owned by the CLI that ships it; "off" ones and copies are not', async () => {
    const config = JSON.stringify({ severity: { 'raw-colour': 'off' } });
    await withApp(
      {
        [SHIPPED_GUARD_CONFIG]: config,
        'guards/raw-fetch.ts': shippedGuardSource('raw-fetch') ?? '',
      },
      async (root) => {
        const codes = await builtInGuardCodes(root);
        expect(codes).toContainEqual({ code: 'X_BARE_ERROR', package: '@ultimat3/cli' });
        expect(codes.map(({ code }) => code)).not.toContain('X_RAW_COLOUR');
        // A copy's code is the app's own, found where the app declares it.
        expect(codes.map(({ code }) => code)).not.toContain('X_RAW_FETCH');
        expect(codes).toHaveLength(SHIPPED_GUARD_NAMES.length - 2);
      },
    );
  });

  test('a legacy app (no shipped.json) lists them too: its gate reports them', async () => {
    await withApp({}, async (root) => {
      expect((await builtInGuardCodes(root)).map(({ code }) => code)).toEqual(
        SHIPPED_GUARD_NAMES.map(guardCode).sort((a, b) => a.localeCompare(b)),
      );
    });
  });

  test('the app declaring a code itself keeps it; the rest join, sorted by code', () => {
    const app = [{ code: 'X_RAW_FETCH', package: 'guards/app-raw-fetch.ts' }];
    const merged = withBuiltInGuardCodes(app, [
      { code: 'X_BARE_ERROR', package: '@ultimat3/cli' },
      { code: 'X_RAW_FETCH', package: '@ultimat3/cli' },
    ]);
    expect(merged).toEqual([
      { code: 'X_BARE_ERROR', package: '@ultimat3/cli' },
      { code: 'X_RAW_FETCH', package: 'guards/app-raw-fetch.ts' },
    ]);
  });
});

test('unit · a built-in code is the code its template raises: guardCode, over the leaf list', () => {
  for (const name of SHIPPED_GUARD_NAMES_LEAF) expect(shippedGuardCode(name)).toBe(guardCode(name));
  expect([...SHIPPED_GUARD_NAMES]).toEqual([...SHIPPED_GUARD_NAMES_LEAF]);
});
