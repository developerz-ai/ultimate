// The `AuditSink` contract of `@ultimat3/core` as shared examples, for a sink of your own:
// `behavesLike(auditSinkConformance, () => subject)`. The port is one `write`, so a subject hands
// back what its storage KEPT, as facts; the suite asks every sink the same questions of them.

import { expect, test } from 'bun:test';
import { ctxOf, secret, userActor } from '@ultimat3/core';
import type { AuditRecord, AuditSink } from '@ultimat3/core/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

/** What a sink kept of one record: the framework's facts, none of the storage. */
export interface AuditKept {
  readonly name: string;
  readonly primitive: string;
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
  /** `at`, as an ISO-8601 instant. */
  readonly at: string;
  /** The input as stored — any shape; the suite only reads its JSON. */
  readonly input: unknown;
}

export interface AuditSinkSubject {
  readonly sink: AuditSink;
  /** Every record this sink kept under `name`, oldest first. */
  kept(name: string): Promise<readonly AuditKept[]>;
  /**
   * True when the sink writes somewhere that outlives the process — then a credential-named input
   * key must never reach it. A process-memory sink keeps the record verbatim and says `false`.
   */
  readonly persists: boolean;
}

export interface AuditSinkCheck {
  readonly name: string;
  run(subject: AuditSinkSubject): Promise<void>;
}

const AT = new Date(1_700_000_000_000);

let minted = 0;
const nameOf = (): string => {
  minted += 1;
  return `conformance${process.pid.toString(36)}x${minted.toString(36)}`;
};

/** Every string field a DIFFERENT value: a sink that files one fact under another is caught. */
const recordFor = (name: string, over: Partial<AuditRecord> = {}): AuditRecord => ({
  at: AT,
  name,
  primitive: 'action',
  mutator: true,
  surface: 'http',
  ctx: ctxOf({
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

/** The facts a sink must keep of `record`, input aside. */
const factsOf = (record: AuditRecord): Omit<AuditKept, 'input'> => ({
  name: record.name,
  primitive: record.primitive,
  outcome: record.outcome,
  surface: record.surface,
  mutator: record.mutator,
  replayed: record.replayed,
  idempotencyKey: record.idempotencyKey,
  failureCode: record.failure?.code ?? null,
  actorId: record.ctx.actor.id,
  actorKind: record.ctx.actor.kind,
  orgId: record.ctx.actor.orgId ?? null,
  requestId: record.ctx.requestId,
  traceId: record.ctx.traceId,
  locale: record.ctx.locale,
  tz: record.ctx.tz,
  buildId: record.ctx.buildId,
  role: record.ctx.role,
  at: record.at.toISOString(),
});

const only = async (subject: AuditSinkSubject, name: string): Promise<AuditKept> => {
  const kept = await subject.kept(name);
  expect(kept).toHaveLength(1);
  return kept[0] as AuditKept;
};

const VARIANTS: readonly (readonly [string, Partial<AuditRecord>])[] = [
  ['an allowed attempt', {}],
  [
    'a DENIED attempt',
    { outcome: 'denied', failure: { code: 'X_FORBIDDEN', error: new RangeError('no') } },
  ],
  [
    'a failed attempt whose thrown value carries no code',
    { outcome: 'failed', failure: { code: null, error: 'a string nobody threw twice' } },
  ],
  ['a replayed idempotent call', { idempotencyKey: 'publishPost:k1', replayed: true }],
  ['an audited READ, from the query primitive', { primitive: 'query', mutator: false }],
  [
    'an input that never parsed',
    { input: undefined, outcome: 'failed', failure: { code: 'X_INPUT_INVALID', error: null } },
  ],
];

export const AUDIT_SINK_CHECKS: readonly AuditSinkCheck[] = [
  ...VARIANTS.map(
    ([label, over]): AuditSinkCheck => ({
      name: `keeps every fact of ${label}`,
      async run(subject) {
        const record = recordFor(nameOf(), over);
        await subject.sink.write(record);
        const kept = await only(subject, record.name);
        const { input: _input, ...facts } = kept;
        expect(facts).toEqual(factsOf(record));
      },
    }),
  ),
  {
    name: 'two identical attempts are two records, never collapsed',
    async run(subject) {
      const record = recordFor(nameOf());
      await subject.sink.write(record);
      await subject.sink.write(record);
      expect(await subject.kept(record.name)).toHaveLength(2);
    },
  },
  {
    name: 'a bigint, a cycle, a Secret and a Date land without a throw, and without a secret',
    async run(subject) {
      const cyclic: Record<string, unknown> = { note: 'a' };
      cyclic['self'] = cyclic;
      const record = recordFor(nameOf(), {
        input: { total: 10n, cyclic, password: 'hunter2', token: secret('sk_live'), when: AT },
      });
      // A sink that throws turns a committed handler into a failed invocation.
      await subject.sink.write(record);
      const kept = await only(subject, record.name);
      if (!subject.persists) return;
      // Whatever a persisting sink falls back to for an unserialisable input, no secret rides it.
      const stored = JSON.stringify(kept.input) ?? '';
      expect(stored).not.toContain('hunter2');
      expect(stored).not.toContain('sk_live');
    },
  },
  {
    name: 'a persisting sink never stores a credential-named input key, from a read or a write',
    async run(subject) {
      for (const primitive of ['action', 'query'] as const) {
        const record = recordFor(nameOf(), {
          primitive,
          mutator: false,
          input: { limit: 5, apiKey: 'sk_live_read', nested: { password: 'hunter2' } },
        });
        await subject.sink.write(record);
        const stored = JSON.stringify((await only(subject, record.name)).input);
        if (!subject.persists) continue;
        expect(stored).toContain('"limit":5');
        expect(stored).not.toContain('sk_live_read');
        expect(stored).not.toContain('hunter2');
      }
    },
  },
];

export const auditSinkConformance: SharedExamples<Maybe<AuditSinkSubject>> = sharedExamples(
  'an audit sink',
  (subject) => {
    for (const check of AUDIT_SINK_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
