/**
 * One question, one answer, whichever sink is installed. Both implementations run FOR REAL here —
 * the ring in memory, the durable one over a recording executor — and every case asserts both
 * inside one `test()`, so neither can move alone.
 *
 * TWO DOCUMENTED DIFFERENCES, each a decision rather than a defect:
 *
 *  - The memory sink retains the record VERBATIM, credential-shaped input included. It is process
 *    memory in the process that already held the value, so redacting there would hide a field from
 *    the developer reading `x dev` without protecting anything. The durable one redacts, because
 *    persisting is where "the framework saw it" becomes "the framework stored it".
 *  - The memory sink DROPS past its cap and says so through `dropped`; the durable one drops
 *    nothing and has no such counter. That asymmetry is the entire reason the durable one exists.
 *
 * Everything else is parity, and the load-bearing case is the last one: a sink that throws turns a
 * committed handler into a failed invocation (`auditSettled`), so neither may raise on a record.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, secret, userActor } from '@ultimat3/core';
import type { AuditRecord, AuditSink } from './audit';
import { memoryAuditSink } from './audit-memory';
import { postgresAuditSink } from './audit-postgres';
import type { PgExecutor } from './idempotency-postgres';

/**
 * `SQL_AUDIT_INSERT`'s parameter order, named once. This is also the pin on that order: a column
 * inserted in the wrong slot is a row whose `actor_id` holds a locale, which no type can catch.
 */
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
] as const;

/** What both sinks are asked to agree on: the facts, none of the storage. */
interface Kept {
  readonly action: string;
  readonly outcome: string;
  readonly surface: string;
  readonly mutator: boolean;
  readonly replayed: boolean;
  readonly idempotencyKey: string | null;
  readonly failureCode: string | null;
  readonly actorId: string;
  readonly actorKind: string;
  readonly orgId: string | null;
  readonly requestId: string;
  readonly traceId: string;
  readonly locale: string;
  readonly tz: string;
  readonly buildId: string;
  readonly role: string;
  readonly at: string;
}

function keptByMemory(record: AuditRecord): Kept {
  const sink = memoryAuditSink({ maxRecords: 8 });
  sink.write(record);
  const kept = sink.records()[0];
  if (kept === undefined) expect.unreachable();
  return {
    action: kept.action,
    outcome: kept.outcome,
    surface: kept.surface,
    mutator: kept.mutator,
    replayed: kept.replayed,
    idempotencyKey: kept.idempotencyKey,
    failureCode: kept.failure?.code ?? null,
    actorId: kept.ctx.actor.id,
    actorKind: kept.ctx.actor.kind,
    orgId: kept.ctx.actor.orgId ?? null,
    requestId: kept.ctx.requestId,
    traceId: kept.ctx.traceId,
    locale: kept.ctx.locale,
    tz: kept.ctx.tz,
    buildId: kept.ctx.buildId,
    role: kept.ctx.role,
    at: kept.at.toISOString(),
  };
}

async function keptByPostgres(record: AuditRecord): Promise<{ kept: Kept; input: unknown }> {
  let params: readonly unknown[] = [];
  const exec: PgExecutor = {
    query<R>(_sql: string, values: readonly unknown[]): Promise<readonly R[]> {
      params = values;
      return Promise.resolve([] as unknown as readonly R[]);
    },
  };
  await postgresAuditSink({ executor: exec }).write(record);
  const at = (name: (typeof COLUMNS)[number]): unknown => params[COLUMNS.indexOf(name)];
  return {
    kept: {
      action: at('action') as string,
      outcome: at('outcome') as string,
      surface: at('surface') as string,
      mutator: at('mutator') as boolean,
      replayed: at('replayed') as boolean,
      idempotencyKey: at('idempotencyKey') as string | null,
      failureCode: at('failureCode') as string | null,
      actorId: at('actorId') as string,
      actorKind: at('actorKind') as string,
      orgId: at('orgId') as string | null,
      requestId: at('requestId') as string,
      traceId: at('traceId') as string,
      locale: at('locale') as string,
      tz: at('tz') as string,
      buildId: at('buildId') as string,
      role: at('role') as string,
      at: at('at') as string,
    },
    input: at('input'),
  };
}

const AT = new Date(1_700_000_000_000);

const recordFor = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  at: AT,
  action: 'publishPost',
  mutator: true,
  surface: 'http',
  // Every string field a DIFFERENT value, on purpose: two columns holding the same word cannot
  // catch a parameter-order slip, and `SQL_AUDIT_INSERT` is positional.
  ctx: createContext({
    requestId: 'req-1',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    locale: 'es-ES',
    tz: 'Europe/Madrid',
    buildId: 'build-7',
    actor: userActor({ id: 'u1', orgId: 'org-1' }),
  }),
  input: { postId: 'p1' },
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
  ...over,
});

const CASES: readonly (readonly [string, AuditRecord])[] = [
  ['an allowed attempt', recordFor()],
  [
    'a DENIED attempt, which is the whole reason this seam is in the framework',
    recordFor({ outcome: 'denied', failure: { code: 'X_FORBIDDEN', error: new Error('no') } }),
  ],
  [
    'a failed attempt whose thrown value carries no code',
    recordFor({ outcome: 'failed', failure: { code: null, error: 'a string nobody threw twice' } }),
  ],
  [
    'a replayed idempotent call, which is a call and not a write',
    recordFor({ idempotencyKey: 'publishPost:k1', replayed: true }),
  ],
  [
    'an input that never parsed',
    recordFor({
      input: undefined,
      outcome: 'failed',
      failure: { code: 'X_INPUT_INVALID', error: null },
    }),
  ],
];

describe('both sinks record the same facts about the same attempt', () => {
  for (const [name, record] of CASES) {
    test(name, async () => {
      const memory = keptByMemory(record);
      const { kept: durable } = await keptByPostgres(record);
      expect(durable).toEqual(memory);
    });
  }
});

describe('neither sink may raise on a record — a throw fails a committed handler', () => {
  const hostile = (): AuditRecord => {
    const cyclic: Record<string, unknown> = { note: 'a' };
    cyclic['self'] = cyclic;
    return recordFor({
      input: {
        total: 10n,
        cyclic,
        password: 'hunter2',
        token: secret('sk_live'),
        when: new Date(0),
      },
    });
  };

  test('a bigint, a cycle, a Secret and a Date all land without a throw', async () => {
    const memory: AuditSink = memoryAuditSink({ maxRecords: 2 });
    expect(() => memory.write(hostile())).not.toThrow();

    const { input } = await keptByPostgres(hostile());
    // The durable side's proof is stronger: what it hands the driver is a STRING, so the value
    // has already survived serialisation by the time any connection is involved.
    expect(typeof input).toBe('string');
    expect(input as string).not.toContain('hunter2');
    expect(input as string).not.toContain('sk_live');
  });
});
