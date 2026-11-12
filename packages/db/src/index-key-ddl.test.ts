// The four index parts beyond a plain column list — an expression key, a direction per key,
// INCLUDE payload columns and the trigram operator class — as `createIndex` writes them, the
// declarations refused before they reach a statement, and the shape a rebuild is decided on.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { IndexDescriptionLike } from './entity-shape';
import { createIndex, indexShape, mayBeConstraintBacked } from './index-ddl';
import { requiredExtension } from './index-key-ddl';

const index = (overrides: Partial<IndexDescriptionLike> = {}): IndexDescriptionLike => ({
  name: 'users_email_idx',
  columns: ['email'],
  unique: false,
  where: null,
  order: null,
  ...overrides,
});

const refusal = (run: () => unknown): UltimateError | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
    throw error;
  }
  return undefined;
};

describe('createIndex · an expression key', () => {
  test('a unique lower(email) is one parenthesised key', () => {
    expect(createIndex('users', index({ unique: true, expression: 'lower(email)' }))).toBe(
      'create unique index "users_email_idx" on "users" ((lower(email)));',
    );
  });

  test('an expression holding a second command is refused before the statement', () => {
    const error = refusal(() =>
      createIndex('users', index({ expression: 'lower(email)); drop table users; --' })),
    );
    expect(error?.code).toBe('X_SQL_UNSAFE');
  });
});

describe('createIndex · a direction per key', () => {
  test('each key carries its own direction, null writing none', () => {
    const feed = index({ columns: ['org_id', 'created_at', 'id'], orders: [null, 'desc', 'asc'] });
    expect(createIndex('posts', feed)).toBe(
      'create index "users_email_idx" on "posts" ("org_id", "created_at" desc, "id" asc);',
    );
  });

  test('a list longer or shorter than the keys is refused', () => {
    const error = refusal(() =>
      createIndex('posts', index({ columns: ['a', 'b'], orders: ['desc'] })),
    );
    expect(error?.code).toBe('X_INVARIANT');
  });

  test('`order` and `orders` together are refused: one way to say a direction', () => {
    const error = refusal(() => createIndex('posts', index({ order: 'desc', orders: ['desc'] })));
    expect(error?.code).toBe('X_INVARIANT');
  });

  test('a direction outside the closed set never reaches the statement', () => {
    const smuggled = ['desc; drop table users; --'] as unknown as readonly ('asc' | 'desc')[];
    expect(refusal(() => createIndex('posts', index({ orders: smuggled })))?.code).toBe(
      'X_SQL_UNSAFE',
    );
  });
});

describe('createIndex · INCLUDE', () => {
  test('payload columns follow the keys, before the predicate', () => {
    const covering = index({ include: ['name', 'id'], where: 'deleted_at is null' });
    expect(createIndex('users', covering)).toBe(
      'create index "users_email_idx" on "users" ("email") include ("name", "id") where (deleted_at is null);',
    );
  });

  test('a gin index cannot carry INCLUDE, so it is refused here rather than at migrate', () => {
    const error = refusal(() => createIndex('users', index({ using: 'gin', include: ['id'] })));
    expect(error?.code).toBe('X_INVARIANT');
  });
});

describe('createIndex · the trigram operator class', () => {
  test('gin_trgm_ops is written after every key', () => {
    const trgm = index({
      name: 'users_name_trgm',
      columns: ['name'],
      using: 'gin',
      operatorClass: 'gin_trgm_ops',
    });
    expect(createIndex('users', trgm)).toBe(
      'create index "users_name_trgm" on "users" using gin ("name" gin_trgm_ops);',
    );
    expect(requiredExtension(trgm)).toBe('pg_trgm');
    expect(requiredExtension(index())).toBeNull();
  });

  test('a trigram class on a btree is refused', () => {
    expect(
      refusal(() => createIndex('users', index({ operatorClass: 'gin_trgm_ops' })))?.code,
    ).toBe('X_INVARIANT');
  });

  test('a class outside the closed set never reaches the statement', () => {
    const smuggled = 'gin_trgm_ops) ; drop table users' as unknown as 'gin_trgm_ops';
    expect(
      refusal(() => createIndex('users', index({ using: 'gin', operatorClass: smuggled })))?.code,
    ).toBe('X_SQL_UNSAFE');
  });
});

describe('indexShape', () => {
  test('a declaration using none of the four parts has the shape it always had', () => {
    expect(indexShape(index())).toBe(JSON.stringify([['email'], false, null, null, 'btree']));
  });

  test('each part moves the shape, so changing one is a rebuild', () => {
    const base = indexShape(index());
    for (const part of [
      { expression: 'lower(email)' },
      { orders: ['desc'] as const },
      { include: ['id'] },
      { using: 'gin' as const, operatorClass: 'gin_trgm_ops' as const },
    ]) {
      expect(indexShape(index(part))).not.toBe(base);
    }
  });
});

describe('mayBeConstraintBacked', () => {
  test('a UNIQUE constraint can back none of the four parts', () => {
    const recorded = { ...index({ unique: true }), primary: false };
    expect(mayBeConstraintBacked(recorded)).toBe(true);
    expect(mayBeConstraintBacked({ ...recorded, include: ['id'] })).toBe(false);
    expect(mayBeConstraintBacked({ ...recorded, expression: 'lower(email)' })).toBe(false);
  });
});
