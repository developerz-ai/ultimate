// `diffSchema` on the key parts past a plain column list: an expression key judged by presence,
// per-key directions folded with `order`, INCLUDE and the operator class compared, and an index
// declaring none of them unchanged.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import { schema, table } from './drift-fixture';
import type { IndexDescription, TableDescription } from './introspect';

const users = table('users', ['id', 'email', 'name']);
const base: IndexDescription = {
  name: 'users_idx',
  columns: ['email'],
  unique: false,
  primary: false,
  where: null,
  order: null,
};
const on = (index: IndexDescription): TableDescription => ({ ...users, indexes: [index] });
const cause = (live: IndexDescription, declared: IndexDescription): string | undefined =>
  diffSchema(schema(on(live)), schema(on(declared))).differences[0]?.cause;

describe('drift · an expression key', () => {
  const declared = { ...base, unique: true, expression: 'lower(email)' };

  test('the catalog spelling of an expression key is clean', () => {
    expect(cause({ ...base, unique: true, columns: ['(lower((email)::text))'] }, declared)).toBe(
      undefined,
    );
  });

  test('a plain column where an expression was declared is drift', () => {
    expect(cause({ ...base, unique: true }, declared)).toContain('not one expression');
  });
});

describe('drift · per-key directions', () => {
  const declared = { ...base, columns: ['email', 'id'], orders: [null, 'desc'] as const };

  test('the same mixed directions are clean, asc and null alike', () => {
    const live = { ...base, columns: ['email', 'id'], orders: [null, 'desc'] as const };
    expect(cause(live, { ...declared, orders: ['asc', 'desc'] })).toBe(undefined);
  });

  test('every key descending reads as the plain `order` the catalog answers', () => {
    const allDesc = { ...declared, orders: ['desc', 'desc'] as const };
    expect(cause({ ...base, columns: ['email', 'id'], order: 'desc' }, allDesc)).toBe(undefined);
  });

  test('a direction flipped by hand is drift', () => {
    expect(cause({ ...base, columns: ['email', 'id'] }, declared)).toContain(
      'orders its keys (asc, asc)',
    );
  });
});

describe('drift · INCLUDE and the operator class', () => {
  test('a missing INCLUDE is drift', () => {
    expect(cause(base, { ...base, include: ['name'] })).toContain('includes no columns');
  });

  test('the same INCLUDE is clean', () => {
    expect(cause({ ...base, include: ['name'] }, { ...base, include: ['name'] })).toBe(undefined);
  });

  test('a trigram index rebuilt on the default class is drift', () => {
    const trgm = { ...base, using: 'gin', operatorClass: 'gin_trgm_ops' };
    expect(cause({ ...base, using: 'gin' }, trgm)).toContain('default operator class');
    expect(cause(trgm, trgm)).toBe(undefined);
  });

  test('an index declaring none of the parts compares exactly as before', () => {
    expect(cause(base, base)).toBe(undefined);
    expect(cause({ ...base, order: 'desc' }, base)).toContain('is descending');
  });
});
