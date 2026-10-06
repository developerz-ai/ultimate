// A package's server barrel, and the browser entry that replaces it — derived from what the
// package publishes, so a new browser entry enters the rule by being published.

import { describe, expect, test } from 'bun:test';
import { barrelImports, serverBarrels } from './server-barrels';

const PUBLISHED = ['@ultimat3/entity', '@ultimat3/entity/record'];

describe('which barrels are a package`s server half', () => {
  test('one that publishes a record, browser or client subpath — and no other', () => {
    const barrels = serverBarrels([
      '@ultimat3/core',
      ...PUBLISHED,
      '@ultimat3/query',
      '@ultimat3/query/client',
      '@ultimat3/realtime/server',
      '@acme/charts/browser',
    ]);
    expect([...barrels]).toEqual([
      ['@ultimat3/entity', '@ultimat3/entity/record'],
      ['@ultimat3/query', '@ultimat3/query/client'],
      ['@acme/charts', '@acme/charts/browser'],
    ]);
  });
});

describe('an import of a server barrel', () => {
  const map = serverBarrels(PUBLISHED);

  test('a value import, a re-export and a dynamic import are each one, with their line', () => {
    const source = [
      "import { recordKey } from '@ultimat3/entity';",
      '',
      "export { rowsOf } from '@ultimat3/entity';",
      "const lazy = await import('@ultimat3/entity');",
    ].join('\n');
    expect(barrelImports(source, map)).toEqual([
      { line: 1, barrel: '@ultimat3/entity', entry: '@ultimat3/entity/record' },
      { line: 3, barrel: '@ultimat3/entity', entry: '@ultimat3/entity/record' },
      { line: 4, barrel: '@ultimat3/entity', entry: '@ultimat3/entity/record' },
    ]);
  });

  test('a type-only import, the browser entry itself and a comment are not', () => {
    expect(barrelImports("import type { Row } from '@ultimat3/entity';", map)).toEqual([]);
    expect(barrelImports("import { type Row, type Key } from '@ultimat3/entity';", map)).toEqual(
      [],
    );
    expect(barrelImports("import { recordKey } from '@ultimat3/entity/record';", map)).toEqual([]);
    expect(barrelImports("// import { x } from '@ultimat3/entity';\n", map)).toEqual([]);
  });

  // A side-effect import binds nothing and still EVALUATES the barrel — the whole server half,
  // SQL renderer included, lands in the island exactly as a value import does.
  test('a side-effect import is one, with its line', () => {
    const source = ["import '@ultimat3/entity/record';", '', 'import "@ultimat3/entity";'].join(
      '\n',
    );
    expect(barrelImports(source, map)).toEqual([
      { line: 3, barrel: '@ultimat3/entity', entry: '@ultimat3/entity/record' },
    ]);
  });

  test('one mixed clause still runs the barrel: a value beside a type', () => {
    expect(
      barrelImports("import { type Row, recordKey } from '@ultimat3/entity';", map),
    ).toHaveLength(1);
  });
});
