// The barrel's own shape: what 25.0.0 took off it stays off. The audit table's DDL is published
// ONCE, by the `@ultimat3/admin/schema` leaf the boot installs from (`cli/src/framework-schema.ts`);
// the insert is `postgresAuditLog`'s alone, and `REDACTED` is core's.
import { describe, expect, test } from 'bun:test';
import * as schema from './audit-schema';
import * as errorGroups from './error-groups';
import * as barrel from './index';

describe('@ultimat3/admin public surface', () => {
  test('no SQL on the barrel — the DDL has one import path, the /schema subpath', () => {
    expect(Object.keys(barrel).filter((name) => name.startsWith('SQL_'))).toEqual([]);
    expect(barrel).not.toHaveProperty('ADMIN_AUDIT_TABLE');
    expect(Object.keys(schema).sort()).toEqual([
      'ADMIN_AUDIT_TABLE',
      'ERROR_GROUPS_TABLE',
      'SQL_ADMIN_AUDIT_TABLE',
      'SQL_ERROR_GROUPS_TABLE',
    ]);
    expect(barrel).not.toHaveProperty('ERROR_GROUPS_TABLE');
  });

  test('the error-groups sink has one door, a subpath no screen rides', () => {
    // Every role installs the sink; on the barrel it would carry every admin screen into a worker.
    expect(barrel).not.toHaveProperty('errorGroupsSink');
    expect(barrel).not.toHaveProperty('postgresErrorGroupsStore');
    expect(typeof errorGroups.errorGroupsSink).toBe('function');
    expect(typeof barrel.errorGroupsPages).toBe('function');
  });

  test("the redaction marker is core's, never a second constant here", () => {
    expect(barrel).not.toHaveProperty('REDACTED');
  });
});
