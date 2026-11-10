// The audit-sink suite over `postgresAuditSink` and a real Postgres (`TEST_DATABASE_URL`): what the
// suite reads back is the `x_audit` row, so a fact filed in the wrong column is a red case here.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresAuditSink, SQL_AUDIT_TABLE } from '@ultimat3/action';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw, sql } from '@ultimat3/db';
import type { AuditKept, AuditSinkSubject } from './audit-sink-conformance';
import { auditSinkConformance } from './audit-sink-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

/** One `x_audit` row, as the driver hands it back. */
interface AuditRow {
  readonly action: string;
  readonly primitive: string;
  readonly outcome: string;
  readonly surface: string;
  readonly mutator: boolean;
  readonly replayed: boolean;
  readonly idempotency_key: string | null;
  readonly failure_code: string | null;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly org_id: string | null;
  readonly request_id: string;
  readonly trace_id: string;
  readonly locale: string;
  readonly tz: string;
  readonly build_id: string;
  readonly role: string;
  readonly at: Date | string;
  readonly input: unknown;
}

const keptOf = (row: AuditRow): AuditKept => ({
  name: row.action,
  primitive: row.primitive,
  outcome: row.outcome,
  surface: row.surface,
  mutator: row.mutator,
  replayed: row.replayed,
  idempotencyKey: row.idempotency_key,
  failureCode: row.failure_code,
  actorId: row.actor_id,
  actorKind: row.actor_kind,
  orgId: row.org_id,
  requestId: row.request_id,
  traceId: row.trace_id,
  locale: row.locale,
  tz: row.tz,
  buildId: row.build_id,
  role: row.role,
  at: new Date(row.at).toISOString(),
  input: row.input,
});

describe.skipIf(adminUrl === '')(testName('live', 'the postgres audit sink'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  let subject: AuditSinkSubject | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_audit_conformance' });
    const pool = postgresClient({ url: db.url, role: 'web', profile: { max: 2 } });
    client = pool;
    for (const statement of SQL_AUDIT_TABLE.split(';')) {
      if (statement.trim().length > 0) await pool.execute(raw(statement));
    }
    subject = {
      sink: postgresAuditSink({ executor: dbExecutor(() => pool) }),
      kept: async (name) =>
        (
          await pool.query<AuditRow>(sql`select * from x_audit where action = ${name} order by id`)
        ).map(keptOf),
      persists: true,
    };
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(auditSinkConformance, () => subject as AuditSinkSubject);
});
