// The `PushDeviceStore` contract of `@ultimat3/notify` as shared examples:
// `behavesLike(pushDeviceStoreConformance, () => store)`. A device is keyed `(platform, token)`,
// never by actor; one order by code point; a remove naming an owner reaches only theirs; a
// bad-token count that survives a re-register. Every check mints its own tokens and actors.

import { expect, test } from 'bun:test';
import type { PushDeviceRecord, PushDeviceStore } from '@ultimat3/notify';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface PushDeviceStoreCheck {
  readonly name: string;
  run(store: PushDeviceStore): Promise<void>;
}

let minted = 0;
/** A per-check suffix: eight hex digits, so an APNs token built on it is still hex. */
const mint = (): string => {
  minted += 1;
  return ((process.pid * 4096 + minted) % 0x1_0000_0000).toString(16).padStart(8, '0');
};

interface Scope {
  readonly ana: string;
  readonly ben: string;
  /** An APNs token: 28 repeats of `pair`, then the check's suffix. */
  ios(pair?: string): string;
  readonly android: string;
  record(overrides?: Partial<PushDeviceRecord>): PushDeviceRecord;
}

const scope = (): Scope => {
  const suffix = mint();
  const ios = (pair = 'ab'): string => `${pair.repeat(28)}${suffix}`;
  const ana = `ana-${suffix}`;
  return {
    ana,
    ben: `ben-${suffix}`,
    ios,
    android: `fcm:${'Z'.repeat(52)}${suffix}`,
    record: (overrides = {}) => ({
      platform: 'ios',
      token: ios(),
      actorId: ana,
      locale: 'es',
      timeZone: 'Europe/Madrid',
      createdAt: Date.parse('2026-11-06T09:00:00Z'),
      ...overrides,
    }),
  };
};

export const PUSH_DEVICE_STORE_CHECKS: readonly PushDeviceStoreCheck[] = [
  {
    name: 'a re-register moves the device and keeps its first createdAt',
    async run(store) {
      const s = scope();
      await store.save(s.record());
      await store.save(s.record({ actorId: s.ben, locale: 'de', createdAt: 0 }));
      expect(await store.listFor(s.ana)).toEqual([]);
      expect(await store.listFor(s.ben)).toEqual([s.record({ actorId: s.ben, locale: 'de' })]);
    },
  },
  {
    name: 'one order, (platform, token) by code point',
    async run(store) {
      const s = scope();
      // Upper case sorts before lower case by code point, and after it in most locales.
      for (const pair of ['cd', 'ab', 'AB']) await store.save(s.record({ token: s.ios(pair) }));
      await store.save(s.record({ platform: 'android', token: s.android }));
      const listed = await store.listFor(s.ana);
      expect(listed.map((d) => `${d.platform}:${d.token.slice(0, 2)}`)).toEqual([
        'android:fc',
        'ios:AB',
        'ios:ab',
        'ios:cd',
      ]);
    },
  },
  {
    name: 'a remove naming another owner is absent; the sender’s remove reaches anyone',
    async run(store) {
      const s = scope();
      await store.save(s.record());
      expect(await store.remove('ios', s.ios(), s.ben)).toBe(false);
      expect(await store.remove('android', s.ios())).toBe(false);
      expect(await store.remove('ios', s.ios())).toBe(true);
      expect(await store.remove('ios', s.ios())).toBe(false);
      expect(await store.listFor(s.ana)).toEqual([]);
    },
  },
  {
    name: 'bad-token answers count up, survive a re-register, and a clear or a missing row is 0',
    async run(store) {
      const s = scope();
      await store.save(s.record());
      expect(await store.noteBadToken('ios', s.ios())).toBe(1);
      expect(await store.noteBadToken('ios', s.ios())).toBe(2);
      await store.save(s.record({ locale: 'de' }));
      expect(await store.listFor(s.ana)).toEqual([s.record({ locale: 'de', badTokens: 2 })]);
      await store.clearBadToken('ios', s.ios());
      expect(await store.listFor(s.ana)).toEqual([s.record({ locale: 'de' })]);
      expect(await store.noteBadToken('android', s.ios())).toBe(0);
    },
  },
  {
    name: 'a caller’s badTokens on save is ignored: only the store counts',
    async run(store) {
      const s = scope();
      await store.save(s.record({ badTokens: 7 }));
      expect(await store.listFor(s.ana)).toEqual([s.record()]);
    },
  },
];

export const pushDeviceStoreConformance: SharedExamples<
  PushDeviceStore | Promise<PushDeviceStore>
> = sharedExamples('a push device store', (subject) => {
  for (const check of PUSH_DEVICE_STORE_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
