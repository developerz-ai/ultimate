// The scaffold's Bun image as the constant the guard and the codemod read, held to the Dockerfile
// `x new` actually emits and to the CLI's own floor: a REQUIRED_BUN or digest bump that leaves one
// of the three behind is red here, not a disagreement every new app is born with.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from '../app-root';
import { SCAFFOLD_BUN_IMAGE, scaffoldDigestPatch } from './bun-image';
import { names } from './naming';
import { containerFiles } from './scaffold-container';

const dockerfile = (): string => {
  const found = containerFiles(names('pin-app')).find((file) => file.path === 'docker/Dockerfile');
  return typeof found?.contents === 'string'
    ? found.contents
    : expect.unreachable('x new writes no docker/Dockerfile as text');
};

describe('SCAFFOLD_BUN_IMAGE', () => {
  test('is the patch the CLI requires, at its series, by digest', () => {
    expect(SCAFFOLD_BUN_IMAGE.patch).toBe(REQUIRED_BUN);
    expect(SCAFFOLD_BUN_IMAGE.series).toBe(REQUIRED_BUN.split('.').slice(0, 2).join('.'));
    expect(SCAFFOLD_BUN_IMAGE.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SCAFFOLD_BUN_IMAGE.ref).toBe(
      `oven/bun:${SCAFFOLD_BUN_IMAGE.series}-${SCAFFOLD_BUN_IMAGE.variant}@${SCAFFOLD_BUN_IMAGE.digest}`,
    );
  });

  test('is every FROM the emitted Dockerfile builds on, and the patch it records', () => {
    const text = dockerfile();
    const froms = [...text.matchAll(/^FROM (oven\/bun:\S+)/gm)].map((match) => match[1]);
    expect(froms.length).toBeGreaterThan(0);
    expect(new Set(froms)).toEqual(new Set([SCAFFOLD_BUN_IMAGE.ref]));
    expect(text).toContain(
      `The digest is \`oven/bun:${SCAFFOLD_BUN_IMAGE.patch}-${SCAFFOLD_BUN_IMAGE.variant}\`'s`,
    );
  });

  test('a digest a released scaffold wrote names the patch it was read from', () => {
    expect(scaffoldDigestPatch(SCAFFOLD_BUN_IMAGE.digest)).toBe(REQUIRED_BUN);
    // 27.10.3 and 28.0.0's, which an app still on them carries until the runtime-pin codemod.
    const earlier = 'sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f';
    expect(scaffoldDigestPatch(earlier)).toBe('1.4.2');
    expect(scaffoldDigestPatch(`sha256:${'e'.repeat(64)}`)).toBeUndefined();
    expect(scaffoldDigestPatch('toString')).toBeUndefined();
  });

  // The FROM line 31.4.0, 31.15.0, 31.20.0 and 31.22.0 each wrote, byte for byte: a floor hop that
  // cannot read its patch asks a human to confirm the framework's own image.
  test("the 31.x scaffolds' FROM digest reads as the patch the CLI requires", () => {
    const shipped =
      'FROM oven/bun:1.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS deps';
    const digest = /@(sha256:[0-9a-f]{64})/.exec(shipped)?.[1] ?? '';
    expect(scaffoldDigestPatch(digest)).toBe(REQUIRED_BUN);
  });
});
