import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
import * as barrel from './index';
import { t } from './index';

describe('@ultimat3/jobs public surface', () => {
  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working schema', () => {
    const schema = t.object({ orgId: t.uuid });
    expect(schema.parse({ orgId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      orgId: '00000000-0000-4000-8000-000000000000',
    });
    expect(() => schema.parse({ orgId: 42 })).toThrow();
  });
});

describe('what 25.0.0 took off the barrel stays off it', () => {
  const names = Object.keys(barrel);

  test('no NATS jobs driver: the all-throw stub went, and nothing stands in for it', () => {
    expect(names.filter((name) => /nats/i.test(name))).toEqual([]);
  });

  test('the SQL a caller outside this package reads, and none of the rest', () => {
    // The kept name has a reader in another workspace: `SQL_JOBS_TABLE` is installed by the boot
    // (`cli/src/framework-schema.ts`) and read by action/notify. `SQL_CLAIM` and
    // `SQL_OUTBOX_RELEASE` are run against a real server by this package's own
    // `driver-pg-array.live.test.ts` — a test is no reason to export a statement (25.0.0).
    expect(names.filter((name) => name.startsWith('SQL_')).sort()).toEqual(['SQL_JOBS_TABLE']);
  });

  test('a memory or Postgres factory has ONE spelling, memoryX / postgresX', () => {
    expect(names.filter((name) => /^create(Memory|Pg|Postgres)[A-Z]|^pg[A-Z]/.test(name))).toEqual(
      [],
    );
    for (const name of [
      'memoryBackfillLedger',
      'memoryJobDriver',
      'memoryEventBus',
      'memoryLeaseStore',
      'memoryOutboxStore',
      'memorySchedulerState',
      'memoryStepStore',
      'postgresJobDriver',
      'postgresEventBus',
      'postgresLeader',
      'postgresLeaseLeader',
      'postgresOutboxStore',
      'postgresSchedulerState',
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
