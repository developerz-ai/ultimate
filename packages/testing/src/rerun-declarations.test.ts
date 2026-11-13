// The rerun seam over a fake name-keyed registry that refuses a duplicate, as `entity()` and `job()`
// do: what a file's BODY declared is forgotten when that same file loads again, and nothing else.

import { describe, expect, test } from 'bun:test';
import { entityDuplicate } from '@ultimat3/entity';
import type { DeclarationRegistry } from './rerun-declarations';
import { frameworkDeclarationRegistries, rerunDeclarations } from './rerun-declarations';

/** A registry as `registerEntity` keeps one: a second declaration of a held name is refused. */
function fakeRegistry() {
  const held = new Map<string, { readonly name: string }>();
  const registry: DeclarationRegistry = {
    kind: 'fake',
    names: () => [...held.keys()],
    forget(names) {
      const gone = [...held.values()].filter((entry) => names.has(entry.name));
      for (const entry of gone) held.delete(entry.name);
      return gone;
    },
    putBack(entries) {
      for (const entry of entries as readonly { readonly name: string }[]) {
        if (!held.has(entry.name)) held.set(entry.name, entry);
      }
    },
  };
  const declare = (name: string): void => {
    if (held.has(name)) throw entityDuplicate(name, name);
    held.set(name, { name });
  };
  return { held, registry, declare };
}

/** One file's load, as the leak guard drives it: load, imports, body start, body, body end. */
function load(
  seam: ReturnType<typeof rerunDeclarations>,
  path: string,
  body: () => void,
  imports: () => void = () => undefined,
): void {
  seam.loading(path);
  imports();
  seam.bodyStart();
  body();
  seam.bodyEnd();
}

describe('rerunDeclarations', () => {
  test('the same file loaded again declares its module scope afresh', () => {
    const { registry, declare, held } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry]);
    load(seam, '/a.test.ts', () => declare('rows'));
    expect(() => load(seam, '/a.test.ts', () => declare('rows'))).not.toThrow();
    expect([...held.keys()]).toEqual(['rows']);
  });

  test('another file declaring the same name is still refused', () => {
    const { registry, declare } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry]);
    load(seam, '/a.test.ts', () => declare('rows'));
    expect(() => load(seam, '/b.test.ts', () => declare('rows'))).toThrow(
      'entity "rows" is already registered',
    );
  });

  test('what its imports declared is never forgotten: the module will not evaluate again', () => {
    const { registry, declare, held } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry]);
    load(
      seam,
      '/a.test.ts',
      () => declare('rows'),
      () => declare('from-a-fixture'),
    );
    // The rerun: the import is a cache hit and declares nothing.
    load(seam, '/a.test.ts', () => declare('rows'));
    expect([...held.keys()].sort()).toEqual(['from-a-fixture', 'rows']);
  });

  test('a body name not declared again this run is put back', () => {
    const { registry, declare, held } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry]);
    // A top-level `await import()` declares in the body window the first time only.
    let first = true;
    const body = (): void => {
      if (first) declare('dynamic');
      first = false;
      declare('rows');
    };
    load(seam, '/a.test.ts', body);
    load(seam, '/a.test.ts', body);
    expect([...held.keys()].sort()).toEqual(['dynamic', 'rows']);
  });

  test("a test's own declaration is not the body's: the file undoes it", () => {
    const { registry, declare } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry]);
    load(seam, '/a.test.ts', () => undefined);
    declare('in-a-test');
    seam.loading('/a.test.ts');
    expect(() => declare('in-a-test')).toThrow('entity "in-a-test" is already registered');
  });

  test('the framework registries: jobs always, entities once their package is loaded', async () => {
    await import('@ultimat3/entity');
    expect(frameworkDeclarationRegistries().map((registry) => registry.kind)).toEqual([
      'job',
      'entity',
    ]);
  });
});
