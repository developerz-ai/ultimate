// Single responsibility: `.sensitive()` reaching the audit record and nothing else. WHY its own
// file: the half that matters is what does NOT change — another action declaring a field of the
// same name, and the idempotency store — and a global key table fails exactly that half.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, REDACTED, userActor } from '@ultimat3/core';
import { installAuditSink, resetAuditSink } from '@ultimat3/core/adapter';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { memoryAuditSink } from './audit-memory';
import { idempotencyKeyFor } from './idempotency-key';
import { memoryIdempotencyStore } from './idempotency-memory';
import { invoke } from './invoke';
import { resetActions } from './registry';

const payer = { ...userActor({ id: 'u1' }), permissions: ['card:charge'] };
const editor = ctxOf({ actor: payer });
const stranger = ctxOf({ actor: userActor({ id: 'u2' }) });
const PAN = '4111111111111111';

const chargeCard = action({
  input: t.object({ cardPan: t.string.sensitive(), note: t.string }),
  output: t.object({ note: t.string }),
  policy: can('card:charge'),
  audit: true,
  handle: ({ input }) => ({ note: input.note }),
}).named('chargeCard');

/** Action B: its own `cardPan`, unflagged, keyed. Nothing about A may change what it records. */
const echoCard = action({
  input: t.object({ cardPan: t.string, note: t.string }),
  output: t.object({ cardPan: t.string, note: t.string }),
  policy: can('card:charge'),
  audit: true,
  idempotent: true,
  handle: ({ input }) => ({ cardPan: input.cardPan, note: input.note }),
}).named('echoCard');

afterEach(() => {
  resetActions();
  resetAuditSink();
});

describe('a .sensitive() input field in the audit record', () => {
  test('reaches the sink as [redacted], with its neighbours readable', async () => {
    const sink = memoryAuditSink();
    installAuditSink(sink);
    await invoke(chargeCard, { cardPan: PAN, note: 'lunch' }, { ctx: editor });
    expect(sink.records()[0]?.input).toEqual({ cardPan: REDACTED, note: 'lunch' });
  });

  test('a denied attempt records the masked input too', async () => {
    const sink = memoryAuditSink();
    installAuditSink(sink);
    await expect(
      invoke(chargeCard, { cardPan: PAN, note: 'lunch' }, { ctx: stranger }),
    ).rejects.toThrow();
    expect(sink.records()[0]?.outcome).toBe('denied');
    expect(sink.records()[0]?.input).toEqual({ cardPan: REDACTED, note: 'lunch' });
  });

  test('another action’s same-named field, and its idempotency record, are untouched', async () => {
    const sink = memoryAuditSink();
    installAuditSink(sink);
    const store = memoryIdempotencyStore();
    await invoke(chargeCard, { cardPan: PAN, note: 'a' }, { ctx: editor });
    const answer = await invoke(
      echoCard,
      { cardPan: PAN, note: 'b' },
      { ctx: editor, idempotencyKey: 'k1', store },
    );
    expect(answer).toEqual({ cardPan: PAN, note: 'b' });
    expect(sink.records()[1]?.input).toEqual({ cardPan: PAN, note: 'b' });
    const kept = await store.get(idempotencyKeyFor('echoCard', 'k1', payer));
    expect(JSON.stringify(kept)).toContain(PAN);
  });

  test('the handler still receives the value the caller sent', async () => {
    let seen: unknown;
    installAuditSink(memoryAuditSink());
    const target = action({
      input: t.object({ cardPan: t.string.sensitive() }),
      output: t.object({ ok: t.boolean }),
      policy: can('card:charge'),
      audit: true,
      handle: ({ input }) => {
        seen = input.cardPan;
        return { ok: true };
      },
    }).named('seeCard');
    await invoke(target, { cardPan: PAN }, { ctx: editor });
    expect(seen).toBe(PAN);
  });
});
