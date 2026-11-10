// The `PushSubscriptionStore` contract of `@ultimat3/pwa` as shared examples:
// `behavesLike(pushSubscriptionStoreConformance, () => store)`. A subscription is keyed by its
// endpoint, never by actor; one order by code point; a remove naming an owner reaches only theirs.
// Every check mints its own endpoints and actors, so one shared table serves them all.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { PushSubscriptionRecord, PushSubscriptionStore } from '@ultimat3/pwa';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface PushSubscriptionStoreCheck {
  readonly name: string;
  run(store: PushSubscriptionStore): Promise<void>;
}

const AT = Date.parse('2026-10-08T12:00:00.000Z');

let minted = 0;
interface Scope {
  readonly ana: string;
  readonly ben: string;
  endpoint(path: string): string;
  record(
    path: string,
    actorId: string,
    overrides?: Partial<PushSubscriptionRecord>,
  ): PushSubscriptionRecord;
}

const scope = (): Scope => {
  minted += 1;
  const id = `${process.pid.toString(36)}-${minted.toString(36)}`;
  const endpoint = (path: string): string => `https://push.test/${id}/${path}`;
  return {
    ana: `ana-${id}`,
    ben: `ben-${id}`,
    endpoint,
    record: (path, actorId, overrides = {}) => ({
      endpoint: endpoint(path),
      keys: { p256dh: `p-${path}`, auth: `a-${path}` },
      locale: 'en',
      timeZone: 'Europe/Berlin',
      actorId,
      createdAt: AT,
      expirationTime: null,
      ...overrides,
    }),
  };
};

export const PUSH_SUBSCRIPTION_STORE_CHECKS: readonly PushSubscriptionStoreCheck[] = [
  {
    name: 'one row per endpoint: a re-subscribe hands the device over with its new keys, first createdAt kept',
    async run(store) {
      const s = scope();
      await store.save(s.record('b', s.ana));
      await store.save(s.record('a', s.ana));
      const handed = { locale: 'de', keys: { p256dh: 'p-new', auth: 'a-new' } };
      await store.save(s.record('b', s.ben, { ...handed, createdAt: AT + 5 }));
      expect((await store.listFor(s.ana)).map((row) => row.endpoint)).toEqual([s.endpoint('a')]);
      expect(await store.listFor(s.ben)).toEqual([s.record('b', s.ben, handed)]);
    },
  },
  {
    name: 'one order, the endpoint by code point',
    async run(store) {
      const s = scope();
      for (const path of ['b', 'B', 'a', 'é']) await store.save(s.record(path, s.ana));
      const listed = (await store.listFor(s.ana)).map((row) => row.endpoint.slice(-1));
      expect(listed).toEqual(['B', 'a', 'b', 'é']);
    },
  },
  {
    name: 'an expiration time round-trips as epoch milliseconds',
    async run(store) {
      const s = scope();
      await store.save(s.record('a', s.ana, { expirationTime: AT + 86_400_000 }));
      expect(await store.listFor(s.ana)).toEqual([
        s.record('a', s.ana, { expirationTime: AT + 86_400_000 }),
      ]);
    },
  },
  {
    // `actorId` is `string`, so only untyped code gets here — and the memory store used to accept
    // what the Postgres column refuses. One refusal, one code, nothing written.
    name: 'a subscription with no actor is refused with X_PWA_PUSH_SUBSCRIPTION_INVALID, nothing stored',
    async run(store) {
      const s = scope();
      for (const actorId of [null, '']) {
        const anonymous = s.record('a', actorId as unknown as string);
        const code = await store.save(anonymous).then(
          () => 'stored',
          (error: unknown) => (isUltimateError(error) ? error.code : 'not an UltimateError'),
        );
        expect(code).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
      }
      expect(await store.remove(s.endpoint('a'))).toBe(false);
    },
  },
  {
    name: 'an owner-scoped remove leaves another actor’s device; an unscoped one is the 410',
    async run(store) {
      const s = scope();
      await store.save(s.record('a', s.ana));
      expect(await store.remove(s.endpoint('a'), s.ben)).toBe(false);
      expect(await store.listFor(s.ana)).toHaveLength(1);
      expect(await store.remove(s.endpoint('a'))).toBe(true);
      expect(await store.remove(s.endpoint('a'))).toBe(false);
      expect(await store.listFor(s.ana)).toEqual([]);
    },
  },
];

export const pushSubscriptionStoreConformance: SharedExamples<
  PushSubscriptionStore | Promise<PushSubscriptionStore>
> = sharedExamples('a push subscription store', (subject) => {
  for (const check of PUSH_SUBSCRIPTION_STORE_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
