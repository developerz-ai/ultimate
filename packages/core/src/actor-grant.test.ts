// The one reading of a permission grant, shared by `@ultimat3/policy` and `@ultimat3/auth`.
import { describe, expect, test } from 'bun:test';
import { grantCovers } from './actor';

describe('grantCovers', () => {
  test('a nested wildcard reaches only its own prefix', () => {
    expect(grantCovers('billing:invoice:*', 'billing:invoice:read')).toBe(true);
    expect(grantCovers('billing:invoice:*', 'billing:invoice:line:edit')).toBe(true);
    expect(grantCovers('billing:invoice:*', 'billing:refund:issue')).toBe(false);
    expect(grantCovers('billing:invoice:*', 'billing:invoicex:read')).toBe(false);
  });

  test('a resource wildcard reaches every depth under the resource, and no neighbour', () => {
    expect(grantCovers('billing:*', 'billing:refund:issue')).toBe(true);
    expect(grantCovers('post:*', 'post:read')).toBe(true);
    expect(grantCovers('post:*', 'poster:read')).toBe(false);
  });

  test('* reaches everything; an exact grant only itself', () => {
    expect(grantCovers('*', 'billing:refund:issue')).toBe(true);
    expect(grantCovers('post:read', 'post:read')).toBe(true);
    expect(grantCovers('post:read', 'post:readall')).toBe(false);
    expect(grantCovers('post:read*', 'post:readall')).toBe(false);
  });
});
