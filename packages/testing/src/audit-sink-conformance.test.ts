// The audit-sink suite over `@ultimat3/action`'s `memoryAuditSink()`, and the proof it can fail: a
// sink that files every record as an action's, the way `x_audit` did before reads were audited, a
// "persisting" one that stores the input verbatim, and one whose serialisation fallback does.

import { describe, expect, test } from 'bun:test';
import { auditableInput, memoryAuditSink } from '@ultimat3/action';
import type { AuditRecord } from '@ultimat3/core/adapter';
import type { AuditKept, AuditSinkSubject } from './audit-sink-conformance';
import { AUDIT_SINK_CHECKS, auditSinkConformance } from './audit-sink-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const keptOf = (record: AuditRecord): AuditKept => ({
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
  input: record.input,
});

/** The memory ring, read back whole; `alter` corrupts what it keeps for the broken cases. */
function memorySubject(
  alter: (record: AuditRecord) => AuditRecord = (record) => record,
  persists = false,
): AuditSinkSubject {
  const sink = memoryAuditSink({ maxRecords: 64 });
  return {
    sink: { write: (record: AuditRecord) => sink.write(alter(record)) },
    kept: async (name) =>
      sink
        .records()
        .filter((record) => record.name === name)
        .map(keptOf),
    persists,
  };
}

describe(testName('unit', 'the memory audit sink'), () => {
  behavesLike(auditSinkConformance, () => memorySubject());
});

const CREDENTIAL = /password|apikey|token/i;

/** Redacts by key through JSON, and on a throw (a bigint, a cycle) stores `Bun.inspect` — verbatim. */
const inspectFallback = (record: AuditRecord): AuditRecord => {
  let input: unknown;
  try {
    input = JSON.parse(
      JSON.stringify(record.input, (key, value: unknown) =>
        CREDENTIAL.test(key) ? '[redacted]' : value,
      ),
    );
  } catch {
    input = Bun.inspect(record.input);
  }
  return { ...record, input };
};

const check = (name: string) => {
  const found = AUDIT_SINK_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'an audit sink that breaks the contract fails conformance'), () => {
  test('a sink that files a read as an action', async () => {
    const actionsOnly = memorySubject((record) => ({ ...record, primitive: 'action' }));
    const read = check('keeps every fact of an audited READ');
    await expect(read.run(actionsOnly)).rejects.toThrow();
    await read.run(memorySubject());
  });

  test('a persisting sink that stores the input verbatim', async () => {
    const leaky = check('a persisting sink never stores');
    await expect(leaky.run(memorySubject(undefined, true))).rejects.toThrow();
  });

  test('a persisting sink whose serialisation fallback keeps the secrets', async () => {
    const hostile = check('a bigint, a cycle, a Secret and a Date');
    // It redacts a plain input, so only the hostile one catches it.
    await check('a persisting sink never stores').run(memorySubject(inspectFallback, true));
    await expect(hostile.run(memorySubject(inspectFallback, true))).rejects.toThrow();
    await hostile.run(
      memorySubject((record) => ({ ...record, input: auditableInput(record.input) }), true),
    );
  });

  test('every check has a name of its own', () => {
    const names = AUDIT_SINK_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
