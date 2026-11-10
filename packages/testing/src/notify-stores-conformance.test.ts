// The notify-stores suite over the memory stores, and the proof each seam's checks can fail: a
// ledger that re-claims a live row, an inbox ordered by insertion, a digest that reopens a window
// for a replayed appender, and a preference store that answers differently each time.

import { describe, expect, test } from 'bun:test';
import {
  allowAllPreferences,
  memoryDeliveryLedger,
  memoryDigestStore,
  memoryInboxStore,
  memoryPreferenceStore,
} from '@ultimat3/notify';
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
import { notifyStoresConformance, preferenceStoreConformance } from './notify-stores-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory notify stores'), () => {
  behavesLike(notifyStoresConformance, () => ({
    ledger: memoryDeliveryLedger(),
    inbox: memoryInboxStore(),
    preferences: memoryPreferenceStore(),
    digest: memoryDigestStore(),
  }));
});

describe(testName('unit', 'the allow-all preference default'), () => {
  behavesLike(preferenceStoreConformance, () => allowAllPreferences());
});

interface Check<S> {
  readonly name: string;
  run(store: S): Promise<void>;
}

/** Every check named, and at least one of them failing the broken store. */
async function failsOne<S>(checks: readonly Check<S>[], broken: () => S): Promise<string[]> {
  const failed: string[] = [];
  for (const check of checks) {
    await check.run(broken()).catch(() => failed.push(check.name));
  }
  return failed;
}

describe(testName('unit', 'a store that breaks its seam fails conformance'), () => {
  test('a ledger that hands a live claim to a second attempt', async () => {
    const greedy = (): DeliveryLedger => {
      const inner = memoryDeliveryLedger();
      return {
        ...inner,
        async claim(claim, at) {
          const answer = await inner.claim(claim, at);
          return answer.outcome === 'held' ? { outcome: 'owned', claimId: 'stolen' } : answer;
        },
      };
    };
    expect(await failsOne(DELIVERY_LEDGER_CHECKS, greedy)).toContain(
      'two claims at once: one owner, and the other is told when to come back',
    );
  });

  test('an inbox that pages in insertion order', async () => {
    const unordered = (): InboxStore => {
      const inner = memoryInboxStore();
      const written: string[] = [];
      return {
        ...inner,
        async add(write) {
          const row = await inner.add(write);
          if (!written.includes(row.id)) written.push(row.id);
          return row;
        },
        async list(query) {
          const rows = await inner.list(query);
          return [...rows].sort((a, b) => written.indexOf(a.id) - written.indexOf(b.id));
        },
      };
    };
    expect(await failsOne(INBOX_STORE_CHECKS, unordered)).toContain(
      'one millisecond: the tie breaks on notifier, then key, by code point',
    );
  });

  test('a digest that forgets who appended, so a replay lands its event twice', async () => {
    const forgetful = (): DigestStore => {
      const inner = memoryDigestStore();
      let call = 0;
      return {
        ...inner,
        append(input) {
          call += 1;
          return inner.append({ ...input, appender: `${input.appender}#${call.toString()}` });
        },
      };
    };
    expect(await failsOne(DIGEST_STORE_CHECKS, forgetful)).toContain(
      'a replayed append answers what the first one did and lands its event once',
    );
  });

  test('a preference store that answers one question two ways', async () => {
    const fickle = (): PreferenceStore => {
      let call = 0;
      return {
        allowsMany(query) {
          call += 1;
          return query.recipients.map((each) => each.id).filter((_, i) => (i + call) % 2 === 0);
        },
      };
    };
    expect(await failsOne(PREFERENCE_STORE_CHECKS, fickle)).toContain(
      'the same question answers the same set',
    );
  });

  test('every check of every seam has a name of its own', () => {
    for (const checks of [
      DELIVERY_LEDGER_CHECKS,
      INBOX_STORE_CHECKS,
      DIGEST_STORE_CHECKS,
      PREFERENCE_STORE_CHECKS,
    ]) {
      const names = checks.map((each) => each.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
