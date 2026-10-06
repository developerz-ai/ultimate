// A generator name the templates would mangle is refused before a file is planned: a plural that
// is pluralised again (`x g resource posts` → `entity('postses')`), a non-ASCII letter dropped in
// silence (`x g entity Über` wrote `ber`), and a type name the emitted code also uses as a global
// (`x g resource promise` → `import type { Promise }` beside `Promise<Promise | undefined>`).

import { describe, expect, test } from 'bun:test';
import { generate } from './generate-files';
import type { Generator } from './generate-kinds';
import { readName } from './generate-kinds';
import { refusePluralTable } from './generate-plural';
import { refuseShadowedTypes, refuseShadowedValues } from './generate-shadow';
import type { GeneratedFile } from './templates';

const refusal = (run: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    run();
  } catch (error) {
    return error as { code: string; cause: string; fix: string };
  }
  return expect.unreachable('expected X_CLI_BAD_FLAG');
};

describe('unit · a plural name is refused where the plan pluralises it into a table', () => {
  const planned = (kind: Generator, name: string, feature?: string): readonly GeneratedFile[] =>
    generate({ kind, name, ...(feature === undefined ? {} : { feature }) });
  const nothingOnDisk = (): boolean => false;

  test.each([
    ['posts', 'resource', 'x g resource post'],
    ['blog-posts', 'entity', 'x g entity blog-post'],
    ['categories', 'resource', 'x g resource category'],
    ['boxes', 'entity', 'x g entity box'],
    ['BlogPosts', 'resource', 'x g resource blog-post'],
    // Not only the two kinds named "entity-ish": a query or a backfill into a slice that has no
    // `entity.ts` yet writes one, and `x g query top-posts` printed `create top_postses`.
    ['top-posts', 'query', 'x g query top-post'],
    ['old-posts', 'backfill', 'x g backfill old-post'],
  ] as const)('%s on %s is refused, with the singular in the fix', (name, kind, fix) => {
    const refused = refusal(() =>
      refusePluralTable(planned(kind, name), kind, name, undefined, nothingOnDisk),
    );
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.cause).toContain(`"${name}"`);
    expect(refused.fix).toBe(fix);
  });

  test('a singular that ends in s, and a plan that writes no entity, pass', () => {
    for (const name of ['status', 'address', 'canvas', 'analysis', 'alias', 'bus']) {
      expect(() =>
        refusePluralTable(planned('resource', name), 'resource', name, undefined, nothingOnDisk),
      ).not.toThrow();
    }
    for (const kind of ['job', 'route', 'action'] as const) {
      expect(() =>
        refusePluralTable(
          planned(kind, 'sync-posts'),
          kind,
          'sync-posts',
          undefined,
          nothingOnDisk,
        ),
      ).not.toThrow();
    }
  });

  test('a slice that already has its entity.ts writes none, so the name is not judged', () => {
    const files = planned('query', 'top-posts');
    expect(() =>
      refusePluralTable(files, 'query', 'top-posts', undefined, (path) =>
        path.endsWith('/entity.ts'),
      ),
    ).not.toThrow();
  });

  test('a plural that came from --feature is fixed on --feature', () => {
    const refused = refusal(() =>
      refusePluralTable(planned('query', 'top', 'posts'), 'query', 'top', 'posts', nothingOnDisk),
    );
    expect(refused.fix).toBe('x g query top --feature post');
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

// TS2440: `import { job } from '@ultimat3/jobs'` beside `export const job = job({ … })` is a module
// that declares the name it imports. Decided on the planned files, like the types above.
describe('unit · a name equal to a value the emitted code imports is refused', () => {
  test.each([
    ['job', 'job'],
    ['action', 'action'],
    ['query', 'query'],
    ['query', 'from'],
    ['task', 'task'],
    ['mutator', 'mutator'],
    ['entity', 'entity'],
    ['entity', 'money'],
  ] as const)('x g %s %s is refused, with a name that compiles in the fix', (kind, name) => {
    const refused = refusal(() => refuseShadowedValues(generate({ kind, name }), kind, name));
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.cause).toContain(`"${name}"`);
    expect(refused.fix).toBe(`x g ${kind} ${name}-${kind}`);
    const fixed = `${name}-${kind}`;
    expect(() => refuseShadowedValues(generate({ kind, name: fixed }), kind, fixed)).not.toThrow();
  });

  test.each([
    ['job', 'sync-posts'],
    ['action', 'publish-post'],
    ['query', 'post-list'],
    ['entity', 'post'],
    ['resource', 'invoice'],
  ] as const)('x g %s %s is allowed', (kind, name) => {
    expect(() => refuseShadowedValues(generate({ kind, name }), kind, name)).not.toThrow();
  });
});
