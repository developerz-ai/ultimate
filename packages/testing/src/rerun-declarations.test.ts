// The rerun seam over a fake name-keyed registry that refuses a duplicate, as `entity()` and `job()`
// do: what a FILE declared — its body, and its tests while no module evaluated — is forgotten when
// that same file loads again, and nothing else.

import { describe, expect, test } from 'bun:test';
import { entityDuplicate } from '@ultimat3/entity';
import type { DeclarationRegistry } from './rerun-declarations';
import { rerunDeclarations } from './rerun-declarations';
import type { ModuleLedger } from './rerun-modules';

/** A module cache by hand: `evaluate` is a test's first `await import()` of a module. */
function fakeModules() {
  const cache = new Map<string, readonly unknown[]>();
  const ledger: ModuleLedger = {
    snapshot: () => new Set(cache.keys()),
    exportsSince: (before) =>
      [...cache].filter(([key]) => !before.has(key)).flatMap(([, values]) => values),
  };
  return {
    ledger,
    evaluate: (key: string, exports: readonly unknown[]) => cache.set(key, exports),
  };
}

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
    exported: (name, values) => values.includes(held.get(name)),
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

  test("a test's or hook's own declaration is forgotten too, not only the body's", () => {
    const { registry, declare, held } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry], fakeModules().ledger);
    const run = (): void => {
      load(seam, '/a.test.ts', () => undefined);
      declare('in-a-test');
      seam.fileEnd();
    };
    run();
    expect(run).not.toThrow();
    expect([...held.keys()]).toEqual(['in-a-test']);
  });

  test('a name a module first evaluated in a test exports is kept: it will not declare again', () => {
    const { registry, declare, held } = fakeRegistry();
    const modules = fakeModules();
    const seam = rerunDeclarations(() => [registry], modules.ledger);
    load(seam, '/a.test.ts', () => undefined);
    // One test: its own declaration, then an `await import('./fixture')` that declares and exports.
    declare('mine');
    declare('from-a-lazy-import');
    modules.evaluate('/fixture.ts', [held.get('from-a-lazy-import'), 'unrelated']);
    seam.fileEnd();
    // The rerun: the import is a cache hit, so its name must still be there; the test's is not.
    load(seam, '/a.test.ts', () => undefined);
    expect([...held.keys()]).toEqual(['from-a-lazy-import']);
    expect(() => declare('mine')).not.toThrow();
  });

  test("a test's name not declared again on the rerun goes back when the file ends", () => {
    const { registry, declare, held } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry], fakeModules().ledger);
    load(seam, '/a.test.ts', () => undefined);
    declare('once');
    seam.fileEnd();
    // The rerun skips that test (`-t`): forgotten while the file runs, back once it is over.
    load(seam, '/a.test.ts', () => undefined);
    expect(held.has('once')).toBe(false);
    seam.fileEnd();
    expect(held.has('once')).toBe(true);
    // …and the run after, which runs that test again, still has it forgotten first.
    load(seam, '/a.test.ts', () => undefined);
    expect(() => declare('once')).not.toThrow();
  });

  test('another file declaring a name a test declared is still refused', () => {
    const { registry, declare } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry], fakeModules().ledger);
    load(seam, '/a.test.ts', () => undefined);
    declare('rows');
    seam.fileEnd();
    load(seam, '/b.test.ts', () => undefined);
    expect(() => declare('rows')).toThrow('entity "rows" is already registered');
  });

  test('a body that threw puts back what was forgotten for it', () => {
    const { registry, declare, held } = fakeRegistry();
    const seam = rerunDeclarations(() => [registry], fakeModules().ledger);
    load(seam, '/a.test.ts', () => declare('rows'));
    seam.fileEnd();
    seam.loading('/a.test.ts');
    seam.bodyStart();
    // …and the body throws before its last line: no `bodyEnd`.
    seam.fileEnd();
    expect([...held.keys()]).toEqual(['rows']);
  });
});
