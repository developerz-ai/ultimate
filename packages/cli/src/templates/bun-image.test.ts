// The scaffold's Bun image as the constant the guard and the codemod read, held to the Dockerfile
// `x new` actually emits and to the CLI's own floor: a REQUIRED_BUN or digest bump that leaves one
// of the three behind is red here, not a disagreement every new app is born with.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from '../app-root';
import { SCAFFOLD_BUN_IMAGE } from './bun-image';
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
});
