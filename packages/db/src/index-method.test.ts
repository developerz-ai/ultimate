// Single responsibility: the index access method — the closed set, the one normalisation both
// sides pass through, and the DDL fragment. The test that matters is in `drift-index-method.test.ts`;
// this file pins the vocabulary underneath it.

import { describe, expect, test } from 'bun:test';
import { INDEX_METHODS, indexMethodOf, indexMethodSql, isIndexMethod } from './index-method';

describe('indexMethodOf', () => {
  test('an index that declared no method is a btree — Postgres own default, written out by nobody', () => {
    expect(indexMethodOf({})).toBe('btree');
    expect(indexMethodOf({ using: undefined })).toBe('btree');
  });

  test('a declared method is answered as it stands', () => {
    expect(indexMethodOf({ using: 'gin' })).toBe('gin');
  });

  test('the catalog is answered verbatim, method the closed set does not carry included', () => {
    // The live side is whatever `pg_am` said. A snapshot declaring `gin` against a live `gist` is
    // a difference an operator must see, and a normalisation that folded it away would hide it.
    expect(indexMethodOf({ using: 'gist' })).toBe('gist');
  });
});

describe('isIndexMethod', () => {
  test('accepts exactly the set, and nothing that merely looks like it', () => {
    expect(INDEX_METHODS).toEqual(['btree', 'gin']);
    expect(isIndexMethod('btree')).toBe(true);
    expect(isIndexMethod('gin')).toBe(true);
    for (const near of ['GIN', 'gist', 'brin', 'hash', 'gin ', '', 'btree, gin']) {
      expect(isIndexMethod(near)).toBe(false);
    }
  });
});

describe('indexMethodSql', () => {
  test('a btree emits nothing — the default form is byte-identical to what shipped before', () => {
    expect(indexMethodSql('btree')).toBe('');
  });

  test('gin emits its clause', () => {
    expect(indexMethodSql('gin')).toBe(' using gin');
  });

  test('the literal is re-derived from the set, never spliced from the input', () => {
    // The identical hole to the one found in `columnName`: an unvalidated value reaching DDL. A
    // method that lied about its type is refused, not interpolated.
    const smuggled = 'gin) ; drop table posts; --' as 'gin';
    expect(() => indexMethodSql(smuggled)).toThrow('X_SQL_UNSAFE');
  });
});
