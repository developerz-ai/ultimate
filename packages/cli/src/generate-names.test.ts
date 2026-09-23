// Rows e and z: a generator name is a directory AND an identifier. `x g action ../../../evil`
// wrote outside `apps/`, `x g entity BlogPost` wrote `app/BlogPost/` beside resource's
// `app/blog-post/`, and `x g action delete` emitted `export const delete = …`, which does not parse.

import { describe, expect, test } from 'bun:test';
import { generate } from './generate-files';
import { readFeature, readName } from './generate-kinds';

const refusal = (run: () => unknown): { code: string; fix: string } => {
  try {
    run();
  } catch (error) {
    return error as { code: string; fix: string };
  }
  return expect.unreachable('expected X_CLI_BAD_FLAG');
};

describe('unit · a generator name is a safe directory and a valid identifier', () => {
  test('a name or --feature carrying a path is refused', () => {
    for (const bad of ['../../../evil', 'a/b', 'a\\b', '..']) {
      expect(refusal(() => readName(bad, 'action')).code).toBe('X_CLI_BAD_FLAG');
      expect(refusal(() => readFeature(bad, 'action')).code).toBe('X_CLI_BAD_FLAG');
    }
    expect(readFeature(undefined, 'action')).toBeUndefined();
    expect(readFeature('blog-post', 'action')).toBe('blog-post');
  });

  test('a reserved word or a leading digit is refused, with a name that works in the fix', () => {
    const reserved = refusal(() => readName('delete', 'action'));
    expect(reserved.code).toBe('X_CLI_BAD_FLAG');
    expect(reserved.fix).toBe('x g action delete-action');
    const digit = refusal(() => readName('2fa-code', 'entity'));
    expect(digit.fix).toBe('x g entity entity-2fa-code');
    expect(readName('publish', 'action')).toBe('publish');
  });

  test('every generator writes its slice at the kebab-case directory resource uses', () => {
    const entity = generate({ kind: 'entity', name: 'BlogPost' });
    expect(entity.every((file) => file.path.startsWith('apps/web/app/blog-post/'))).toBe(true);
  });
});
