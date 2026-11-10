// The `NotifyStores` port of `@ultimat3/notify` as shared examples: `notifyStoresConformance` asks
// all four seams an app's `notifyStores:` line hands over; one seam alone is
// `behavesLike(inboxStoreConformance, () => inbox)`. The subject is called once per test — every
// check names its own recipient, notifier or slot, so a store with rows from other checks is fine.

import { describe, test } from 'bun:test';
import type {
  DeliveryLedger,
  DigestStore,
  InboxStore,
  PreferenceStore,
} from '@ultimat3/notify/adapter';
import { DIGEST_STORE_CHECKS } from './notify-digest-conformance';
import { INBOX_STORE_CHECKS } from './notify-inbox-conformance';
import { DELIVERY_LEDGER_CHECKS } from './notify-ledger-conformance';
import { PREFERENCE_STORE_CHECKS } from './notify-preference-conformance';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

/** Every seam present: an app installing fewer runs the per-seam suites for the ones it wrote. */
export interface NotifyStoresSubject {
  readonly ledger: DeliveryLedger;
  readonly inbox: InboxStore;
  readonly preferences: PreferenceStore;
  readonly digest: DigestStore;
}

interface Check<S> {
  readonly name: string;
  run(store: S): Promise<void>;
}

const register = <S>(checks: readonly Check<S>[], subject: () => Maybe<S>): void => {
  for (const check of checks) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
};

export const deliveryLedgerConformance: SharedExamples<Maybe<DeliveryLedger>> = sharedExamples(
  'a delivery ledger',
  (subject) => register(DELIVERY_LEDGER_CHECKS, subject),
);

export const inboxStoreConformance: SharedExamples<Maybe<InboxStore>> = sharedExamples(
  'an inbox store',
  (subject) => register(INBOX_STORE_CHECKS, subject),
);

export const digestStoreConformance: SharedExamples<Maybe<DigestStore>> = sharedExamples(
  'a digest store',
  (subject) => register(DIGEST_STORE_CHECKS, subject),
);

export const preferenceStoreConformance: SharedExamples<Maybe<PreferenceStore>> = sharedExamples(
  'a preference store',
  (subject) => register(PREFERENCE_STORE_CHECKS, subject),
);

export const notifyStoresConformance: SharedExamples<Maybe<NotifyStoresSubject>> = sharedExamples(
  'the notify stores',
  (subject) => {
    describe('ledger', () =>
      register(DELIVERY_LEDGER_CHECKS, async () => (await subject()).ledger));
    describe('inbox', () => register(INBOX_STORE_CHECKS, async () => (await subject()).inbox));
    describe('preferences', () =>
      register(PREFERENCE_STORE_CHECKS, async () => (await subject()).preferences));
    describe('digest', () => register(DIGEST_STORE_CHECKS, async () => (await subject()).digest));
  },
);
