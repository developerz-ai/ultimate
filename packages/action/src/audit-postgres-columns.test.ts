// `SQL_AUDIT_INSERT` is POSITIONAL, so its parameter order is pinned here, in the unit step, with a
// distinct value per field: a fact in the wrong slot is a row whose `actor_id` holds a locale. The
// store contract itself is `@ultimat3/testing`'s `auditSinkConformance`, which reads real rows live.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { ctxOf, secret, userActor } from '@ultimat3/core';
import type { AuditRecord } from './audit';
import { postgresAuditSink } from './audit-postgres';

/** `SQL_AUDIT_INSERT`'s parameter order, named once. */
const COLUMNS = [
  'id',
  'at',
  'action',
  'mutator',
  'surface',
  'outcome',
  'replayed',
  'idempotencyKey',
  'failureCode',
  'actorId',
  'actorKind',
  'orgId',
  'onBehalfOfId',
  'onBehalfOfKind',
  'requestId',
  'traceId',
  'locale',
  'tz',
  'buildId',
  'role',
  'input',
  'primitive',
] as const;

type Column = (typeof COLUMNS)[number];

async function rowOf(record: AuditRecord): Promise<Readonly<Record<Column, unknown>>> {
  let params: readonly unknown[] = [];
  const executor: PgExecutor = {
    query<R>(_text: string, values: readonly unknown[]): Promise<readonly R[]> {
      params = values;
      return Promise.resolve([]);
    },
  };
  await postgresAuditSink({ executor }).write(record);
  expect(params).toHaveLength(COLUMNS.length);
  return Object.fromEntries(COLUMNS.map((name, index) => [name, params[index]])) as Record<
    Column,
    unknown
  >;
}

const AT = new Date(1_700_000_000_000);

const recordFor = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  at: AT,
  name: 'postList',
  primitive: 'query',
  mutator: false,
  surface: 'mcp',
  ctx: ctxOf({
    requestId: 'req-1',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    locale: 'es-ES',
    tz: 'Europe/Madrid',
    buildId: 'build-7',
    actor: userActor({ id: 'u1', orgId: 'org-1' }),
  }),
  input: { limit: 5 },
  idempotencyKey: 'postList:k1',
  replayed: true,
  outcome: 'denied',
  failure: { code: 'X_FORBIDDEN', error: new RangeError('no') },
  ...over,
});

describe('the postgres audit sink fills every positional slot with its own fact', () => {
  test('a distinct value per field lands in its own column', async () => {
    const row = await rowOf(recordFor());
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect({ ...row, id: 'uuid' }).toEqual({
      id: 'uuid',
      at: AT.toISOString(),
      action: 'postList',
      mutator: false,
      surface: 'mcp',
      outcome: 'denied',
      replayed: true,
      idempotencyKey: 'postList:k1',
      failureCode: 'X_FORBIDDEN',
      actorId: 'u1',
      actorKind: 'user',
      orgId: 'org-1',
      onBehalfOfId: null,
      onBehalfOfKind: null,
      requestId: 'req-1',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      locale: 'es-ES',
      tz: 'Europe/Madrid',
      buildId: 'build-7',
      role: row.role,
      input: '{"limit":5}',
      primitive: 'query',
    });
    expect(typeof row.role).toBe('string');
  });

  test('a bigint, a cycle, a Secret and a Date reach the driver as a string with no secret', async () => {
    const cyclic: Record<string, unknown> = { note: 'a' };
    cyclic['self'] = cyclic;
    const { input } = await rowOf(
      recordFor({
        input: { total: 10n, cyclic, password: 'hunter2', token: secret('sk_live'), when: AT },
      }),
    );
    expect(typeof input).toBe('string');
    expect(input as string).not.toContain('hunter2');
    expect(input as string).not.toContain('sk_live');
  });
});
