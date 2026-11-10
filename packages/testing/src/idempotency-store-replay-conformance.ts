// The replay half of `idempotencyStoreConformance`: an answer at rest holds no credential, and an
// answer no retry could replay is one verdict on every store — refused first and on replay.

import { expect } from 'bun:test';
import { withIdempotency } from '@ultimat3/action';
import { finiteCount } from '@ultimat3/core';
import { withTransaction } from '@ultimat3/db';
import type { IdempotencyWorldCheck as TxCheck } from './idempotency-store-world-conformance';
import { codeOf, DAY_MS, world } from './idempotency-store-world-conformance';

/** An answer at rest for a day holds no credential, and the replay that lost one is refused. */
const REDACTION: readonly TxCheck[] = [
  {
    name: 'a secret answer rests [redacted], flagged, and its replay is refused',
    async run(subject) {
      const w = await world(subject);
      expect(await w.once({ id: 'key_1', apiKey: 'sk_live_plaintext' })).toEqual({
        value: { id: 'key_1', apiKey: 'sk_live_plaintext' },
        replayed: false,
      });
      const stored = await subject.store.get(w.key);
      expect(stored?.value).toEqual({ id: 'key_1', apiKey: '[redacted]' });
      expect(stored?.redacted).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('sk_live_plaintext');
      expect(codeOf(await w.once({ id: 'never-run' }).catch((e: unknown) => e))).toBe(
        'X_IDEMPOTENT_REPLAY_REDACTED',
      );
    },
  },
  {
    name: 'a secret nested in objects, arrays and toJSON is redacted where it sits',
    async run(subject) {
      const w = await world(subject);
      const leaky = { toJSON: () => ({ apiKey: 'sk_live_tojson' }) };
      await w.once({ logins: [{ label: 'main', password: 'hunter2' }], creds: leaky });
      const stored = await subject.store.get(w.key);
      expect(stored?.value).toMatchObject({ logins: [{ label: 'main', password: '[redacted]' }] });
      expect(JSON.stringify(stored)).not.toContain('sk_live_tojson');
      expect(stored?.redacted).toBe(true);
    },
  },
  {
    name: 'a cyclic answer settles redacted, and its replay is refused',
    async run(subject) {
      const w = await world(subject);
      const answer: Record<string, unknown> = { id: 'k1' };
      answer['self'] = answer;
      expect(await w.once(answer)).toEqual({ value: answer, replayed: false });
      const stored = await subject.store.get(w.key);
      expect(stored).toMatchObject({ status: 'settled', value: { id: 'k1', self: '[redacted]' } });
      expect(codeOf(await w.once(null).catch((e: unknown) => e))).toBe(
        'X_IDEMPOTENT_REPLAY_REDACTED',
      );
    },
  },
  {
    name: 'an answer with no secret replays exactly as it was given',
    async run(subject) {
      const w = await world(subject);
      const answer = { charged: 'ch_1', amount: { minor: 1250, currency: 'EUR' }, tags: ['a'] };
      await w.once(answer);
      expect((await subject.store.get(w.key))?.redacted).not.toBe(true);
      expect(await w.once({ charged: 'never-run' })).toEqual({ value: answer, replayed: true });
    },
  },
  {
    name: 'inside a transaction the settle that commits with the write is redacted too',
    async run(subject) {
      const w = await world(subject);
      await withTransaction(() => w.once({ token: 'tok_plaintext' }), { client: subject.client });
      expect(await subject.store.get(w.key)).toMatchObject({
        value: { token: '[redacted]' },
        redacted: true,
      });
    },
  },
  {
    name: 'a key reclaimed past the window forgets the redaction with the answer',
    async run(subject) {
      const w = await world(subject);
      await w.once({ apiKey: 'sk_1' });
      await w.age(
        finiteCount(
          'idempotencyStoreConformance',
          'windowMs',
          subject.store.windowMs ?? DAY_MS,
          1,
        ) + 1_000,
      );
      expect(await w.once({ charged: 'ch_2' })).toEqual({
        value: { charged: 'ch_2' },
        replayed: false,
      });
      expect((await subject.store.get(w.key))?.redacted).not.toBe(true);
    },
  },
];

/** An answer no retry could replay is ONE verdict, the same on every store, and runs once. */
const UNSERIALISABLE: readonly TxCheck[] = [
  ...(
    [
      ['a bigint', { n: 5n }],
      ['a NUL', { note: 'a\u0000b' }],
      ['a lone surrogate', { note: 'x\ud83d' }],
    ] as const
  ).map(
    ([label, answer]): TxCheck => ({
      name: `${label}: refused first and on replay, failed at rest, and the handler ran once`,
      async run(subject) {
        const w = await world(subject);
        let runs = 0;
        const once = () =>
          withIdempotency(subject.store, w.key, { id: 'same-payload' }, () => {
            runs += 1;
            return Promise.resolve(answer);
          }).catch((error: unknown) => error);
        expect(codeOf(await once())).toBe('X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE');
        expect((await subject.store.get(w.key))?.status).toBe('failed');
        const replay = await once();
        expect(codeOf(replay)).toBe('X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE');
        expect((replay as { meta?: { replayed?: unknown } }).meta?.replayed).toBe(true);
        expect(runs).toBe(1);
      },
    }),
  ),
  {
    // JSON has no `undefined`: a store keeps `null`, and the action's `output` schema answers for it.
    name: 'undefined settles, and the record holds no value',
    async run(subject) {
      const w = await world(subject);
      expect((await w.once(undefined)).replayed).toBe(false);
      const stored = await subject.store.get(w.key);
      expect(stored?.status).toBe('settled');
      expect(stored?.value ?? null).toBeNull();
    },
  },
];

export const IDEMPOTENCY_REPLAY_CHECKS: readonly TxCheck[] = [...REDACTION, ...UNSERIALISABLE];
