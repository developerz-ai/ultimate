// Single responsibility: `.sensitive()` reaching a read's audit record — allowed and denied — and
// nothing else. WHY its own file: the half that matters is another read's same-named field, which
// a global key table would change and this design must not.

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuditRecord, AuditSink } from '@ultimat3/core';
import { ctxOf, REDACTED, resetAuditSink, setAuditSink, userActor } from '@ultimat3/core';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { runQuery } from './read';
import { resetQueries } from './registry';
import { from } from './source';

const reader: PolicyActor = { ...userActor({ id: 'u1' }), permissions: ['payer:read'] };
const stranger: PolicyActor = { ...userActor({ id: 'u2' }), permissions: [] };
const SSN = '078-05-1120';

const collecting = (): AuditSink & { readonly records: AuditRecord[] } => {
  const records: AuditRecord[] = [];
  return { records, write: (record) => void records.push(record) };
};

const lookup = (sensitive: boolean, name: string) =>
  query({
    input: t.object({ ssn: sensitive ? t.string.sensitive() : t.string, note: t.string }),
    policy: can('payer:read'),
    audit: true,
    sql: () => from<{ id: string }>('payers', () => [{ id: 'p1' }]).orderBy('id', 'asc'),
  }).named(name);

afterEach(() => {
  resetQueries();
  resetAuditSink();
});

describe('a .sensitive() input field in a read’s audit record', () => {
  test('is [redacted] on an allowed read; another read’s same-named field is not', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const ctx = ctxOf({ actor: reader });
    await runQuery(lookup(true, 'payerBySsn'), { ssn: SSN, note: 'n' }, { ctx });
    await runQuery(lookup(false, 'payerEcho'), { ssn: SSN, note: 'n' }, { ctx });
    expect(sink.records.map((record) => record.input)).toEqual([
      { ssn: REDACTED, note: 'n' },
      { ssn: SSN, note: 'n' },
    ]);
  });

  test('is [redacted] on a denied read too', async () => {
    const sink = collecting();
    setAuditSink(sink);
    await expect(
      runQuery(
        lookup(true, 'payerBySsn'),
        { ssn: SSN, note: 'n' },
        {
          ctx: ctxOf({ actor: stranger }),
        },
      ),
    ).rejects.toThrow();
    expect(sink.records[0]?.outcome).toBe('denied');
    expect(sink.records[0]?.input).toEqual({ ssn: REDACTED, note: 'n' });
  });
});
