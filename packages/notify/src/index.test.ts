// The barrel's own shape: what 25.0.0 took off it stays off. The SQL a caller outside this package
// runs is exported; the statements only this package executes are read from their own modules.
import { describe, expect, test } from 'bun:test';
import * as barrel from './index';

describe('@ultimat3/notify public surface', () => {
  const names = Object.keys(barrel);

  test('the SQL another workspace reads, and none of the rest', () => {
    // The three tables are installed by the boot (`cli/src/framework-schema.ts`). MARK_READ went in
    // 25.0.0: its one reader was a live test, and a test is no reason to export a statement — the
    // composition test drives `postgresInboxStore().markRead()`. CLAIM and INBOX_PAGE had no reader.
    expect(names.filter((name) => name.startsWith('SQL_')).sort()).toEqual([
      'SQL_NOTIFY_DELIVERIES_TABLE',
      'SQL_NOTIFY_DIGESTS_TABLE',
      'SQL_NOTIFY_INBOX_TABLE',
    ]);
  });

  test('a memory or Postgres store has ONE spelling, memoryX / postgresX', () => {
    expect(names.filter((name) => /^create(Memory|Pg|Postgres)[A-Z]|^pg[A-Z]/.test(name))).toEqual(
      [],
    );
    for (const name of [
      'memoryDeliveryLedger',
      'memoryDigestStore',
      'memoryInboxStore',
      'memoryPreferenceStore',
      'postgresDeliveryLedger',
      'postgresDigestStore',
      'postgresInboxStore',
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
