// The barrel's own shape: what 25.0.0 took off it stays off. `SQL_ADMIN_AUDIT_TABLE` is installed by
// the boot (`cli/src/framework-schema.ts`); the insert is `postgresAuditLog`'s alone.
import { describe, expect, test } from 'bun:test';
import * as barrel from './index';

describe('@ultimat3/admin public surface', () => {
  test('the SQL another workspace reads, and none of the rest', () => {
    expect(
      Object.keys(barrel)
        .filter((name) => name.startsWith('SQL_'))
        .sort(),
    ).toEqual(['SQL_ADMIN_AUDIT_TABLE']);
  });
});
