// The barrel's own shape: what 25.0.0 took off it stays off. The audit table's DDL is published
// ONCE, by the `@ultimat3/admin/schema` leaf the boot installs from (`cli/src/framework-schema.ts`);
// the insert is `postgresAuditLog`'s alone, and `REDACTED` is core's.
import { describe, expect, test } from 'bun:test';
import * as schema from './audit-schema';
import * as barrel from './index';

describe('@ultimat3/admin public surface', () => {
  test('no SQL on the barrel — the DDL has one import path, the /schema subpath', () => {
    expect(Object.keys(barrel).filter((name) => name.startsWith('SQL_'))).toEqual([]);
    expect(barrel).not.toHaveProperty('ADMIN_AUDIT_TABLE');
    expect(Object.keys(schema).sort()).toEqual(['ADMIN_AUDIT_TABLE', 'SQL_ADMIN_AUDIT_TABLE']);
  });

  test("the redaction marker is core's, never a second constant here", () => {
    expect(barrel).not.toHaveProperty('REDACTED');
  });
});
