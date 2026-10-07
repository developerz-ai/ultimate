// The Postgres queue's statements, read as text: the clauses whose absence no fake executor
// would notice — SKIP LOCKED, the partial unique index, the advisory lock.

import { describe, expect, test } from 'bun:test';
import {
  SQL_ACK,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_HEARTBEAT,
  SQL_JOBS_TABLE,
  SQL_NACK,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';

describe('pg queue SQL', () => {
  test('the claim uses FOR UPDATE SKIP LOCKED — without it N workers serialise', () => {
    expect(SQL_CLAIM).toContain('for update skip locked');
    expect(SQL_CLAIM).toContain("set state      = 'running'");
    // Lease reclaim: a crashed worker's job becomes claimable again.
    expect(SQL_CLAIM).toContain("state = 'running' and visible_at <= now()");
    expect(SQL_CLAIM).toContain('attempt    = j.attempt + 1');
  });

  test('idempotency is enforced per JOB and per TENANT by a partial unique index over live states only', () => {
    // `(name, coalesce(tenant_id, ''), idempotency_key)`. A global key namespace was silent data
    // loss — two jobs deriving the same natural key deduped against each other and the second one
    // never ran — and a tenant-blind one was that plus a cross-tenant job id handed to the caller.
    expect(SQL_JOBS_TABLE).toContain(
      'create unique index if not exists x_jobs_name_tenant_idempotency_live_idx',
    );
    expect(SQL_JOBS_TABLE).toContain(
      "on x_jobs (name, (coalesce(tenant_id, '')), idempotency_key)",
    );
    expect(SQL_JOBS_TABLE).toContain("where state in ('ready', 'delayed', 'running', 'suspended')");
    // The conflict target must spell the index expression exactly, or Postgres cannot infer it.
    expect(SQL_ENQUEUE).toContain("on conflict (name, (coalesce(tenant_id, '')), idempotency_key)");
    expect(SQL_ENQUEUE).toContain('do nothing');
  });

  test('nack only burns an attempt when the failure counts as one', () => {
    expect(SQL_NACK).toContain(
      'case when $3::boolean then attempt else greatest(attempt - 1, 0) end',
    );
  });

  test('ack and heartbeat target a single row by id', () => {
    expect(SQL_ACK).toContain('where id = $1');
    expect(SQL_HEARTBEAT).toContain("where id = $1 and state = 'running'");
  });

  test('the scheduler leader uses a session advisory lock', () => {
    expect(SQL_TRY_ADVISORY_LOCK).toContain('pg_try_advisory_lock');
  });
});
