// A generator name the templates would mangle is refused before a file is planned: a plural that
// is pluralised again (`x g resource posts` → `entity('postses')`), a non-ASCII letter dropped in
// silence (`x g entity Über` wrote `ber`), and a type name the emitted code also uses as a global
// (`x g resource promise` → `import type { Promise }` beside `Promise<Promise | undefined>`).

import { describe, expect, test } from 'bun:test';
import { generate } from './generate-files';
import { readName } from './generate-kinds';
import { refuseShadowedTypes } from './generate-shadow';
import type { GeneratedFile } from './templates';

const refusal = (run: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    run();
  } catch (error) {
    return error as { code: string; cause: string; fix: string };
  }
  return expect.unreachable('expected X_CLI_BAD_FLAG');
};

describe('unit · a plural name is refused where the generator pluralises it', () => {
  test.each([
    ['posts', 'resource', 'x g resource post'],
    ['blog-posts', 'entity', 'x g entity blog-post'],
    ['categories', 'resource', 'x g resource category'],
    ['boxes', 'entity', 'x g entity box'],
    ['BlogPosts', 'resource', 'x g resource blog-post'],
  ])('%s on %s is refused, with the singular in the fix', (name, kind, fix) => {
    const refused = refusal(() => readName(name, kind as 'resource' | 'entity'));
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.fix).toBe(fix);
  });

  test('a singular that ends in s, and a plural on a generator that pluralises nothing, pass', () => {
    for (const name of ['status', 'address', 'canvas', 'analysis', 'alias', 'bus']) {
      expect(readName(name, 'resource')).toBe(name);
    }
    expect(readName('sync-posts', 'job')).toBe('sync-posts');
    expect(readName('posts', 'route')).toBe('posts');
  });
});

describe('unit · a non-ASCII name is refused, never folded in silence', () => {
  test('a letter the name would lose is refused, with its ASCII spelling in the fix', () => {
    const refused = refusal(() => readName('Über', 'entity'));
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.cause).toContain('Über');
    expect(refused.fix).toBe('x g entity uber');
  });

  test('a name with no ASCII spelling gets the generator`s example in the fix', () => {
    expect(refusal(() => readName('日本', 'action')).fix).toBe('x g action publish-post');
  });
});

describe('unit · a type name the emitted code uses as a global is refused', () => {
  const files = (name: string): readonly GeneratedFile[] => generate({ kind: 'resource', name });

  test.each(['promise', 'omit', 'partial', 'row'])('x g resource %s is refused', (name) => {
    const refused = refusal(() => refuseShadowedTypes(files(name), 'resource', name));
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.fix).toBe(`x g resource ${name}-resource`);
  });

  test('x g entity promise is refused too: its repo returns Promise<…>', () => {
    const entity = generate({ kind: 'entity', name: 'promise' });
    expect(refusal(() => refuseShadowedTypes(entity, 'entity', 'promise')).fix).toBe(
      'x g entity promise-entity',
    );
  });

  // The names the audit checked and found sound stay allowed: none of them is a type the same
  // emitted file also uses as the global.
  test.each(['post', 'record', 'response', 'event', 'error', 'date', 'money'])(
    'x g resource %s is allowed',
    (name) => {
      expect(() => refuseShadowedTypes(files(name), 'resource', name)).not.toThrow();
    },
  );
});
