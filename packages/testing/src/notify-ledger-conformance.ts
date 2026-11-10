// The `DeliveryLedger` contract of `@ultimat3/notify` as checks: the claim that stops a replayed
// attempt short of a second send. The reclaim window is READ from the ledger (the `held` answer a
// fresh claim's twin gets), so a ledger of any window proves itself; every check names its own
// notifier, so one shared table serves them all.

import { expect } from 'bun:test';
import type { DeliveryClaim, DeliveryClaimAnswer, DeliveryLedger } from '@ultimat3/notify/adapter';

export interface DeliveryLedgerCheck {
  readonly name: string;
  run(ledger: DeliveryLedger): Promise<void>;
}

const AT = new Date('2026-08-24T09:00:00Z');
const after = (ms: number): Date => new Date(AT.getTime() + ms);

let minted = 0;
/** A bulk claim (NULL recipient) no other check, run or process shares. */
const claimOf = (): DeliveryClaim => {
  minted += 1;
  const notifier = `conformance.${process.pid.toString(36)}.${minted.toString(36)}`;
  return { notifier, key: 'k1', recipient: null, channel: 'slack' };
};

/** The claim id of an answer that must have been `owned`. */
const owned = (answer: DeliveryClaimAnswer): string =>
  answer.outcome === 'owned' ? answer.claimId : expect.unreachable(`got ${answer.outcome}`);

/** The ledger's reclaim window, as its own `held` answer states it. */
async function windowOf(ledger: DeliveryLedger): Promise<number> {
  const probe = claimOf();
  owned(await ledger.claim(probe, AT));
  const answer = await ledger.claim(probe, AT);
  if (answer.outcome !== 'held')
    return expect.unreachable(`a live claim answered ${answer.outcome}`);
  expect(answer.retryAfterMs).toBeGreaterThan(0);
  return answer.retryAfterMs;
}

export const DELIVERY_LEDGER_CHECKS: readonly DeliveryLedgerCheck[] = [
  {
    name: 'a NULL and an empty recipient are ONE delivery: sent once, never claimed again',
    async run(ledger) {
      const bulk = claimOf();
      await ledger.settle(bulk, 'sent', AT, owned(await ledger.claim(bulk, AT)));
      expect(await ledger.claim({ ...bulk, recipient: '' }, AT)).toEqual({ outcome: 'sent' });
      expect(await ledger.find({ ...bulk, recipient: '' })).toMatchObject({
        recipient: null,
        status: 'sent',
        attempts: 1,
      });
    },
  },
  {
    name: 'a settle with no claim records nothing, so the claim after it still sends',
    async run(ledger) {
      const bulk = claimOf();
      expect(await ledger.settle(bulk, 'sent', AT, crypto.randomUUID())).toBe(false);
      expect(await ledger.find(bulk)).toBeUndefined();
      owned(await ledger.claim(bulk, AT));
    },
  },
  {
    name: 'two claims at once: one owner, and the other is told when to come back',
    async run(ledger) {
      const window = await windowOf(ledger);
      const bulk = claimOf();
      const answers = await Promise.all([ledger.claim(bulk, AT), ledger.claim(bulk, AT)]);
      expect(answers.filter((answer) => answer.outcome === 'owned')).toHaveLength(1);
      const other = answers.find((answer) => answer.outcome !== 'owned');
      expect(other).toEqual({ outcome: 'held', retryAfterMs: window });
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sending', attempts: 1 });
    },
  },
  {
    name: 'a live claim is held up to the window, and reclaimed one past it',
    async run(ledger) {
      const window = await windowOf(ledger);
      const bulk = claimOf();
      owned(await ledger.claim(bulk, AT));
      expect(await ledger.claim(bulk, after(window))).toEqual({ outcome: 'held', retryAfterMs: 0 });
      owned(await ledger.claim(bulk, after(window + 1)));
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sending', attempts: 2 });
    },
  },
  {
    name: "a late settle changes nothing: the row is its reclaimer's",
    async run(ledger) {
      const window = await windowOf(ledger);
      const bulk = claimOf();
      const late = owned(await ledger.claim(bulk, AT));
      const current = owned(await ledger.claim(bulk, after(window + 1)));
      expect(current).not.toBe(late);
      expect(await ledger.settle(bulk, 'failed', after(window + 2), late)).toBe(false);
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sending' });
      expect(await ledger.settle(bulk, 'sent', after(window + 3), current)).toBe(true);
      expect(await ledger.settle(bulk, 'failed', after(window + 4), late)).toBe(false);
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sent' });
    },
  },
  {
    name: 'an attempt cannot move its own `sent` back to `failed`',
    async run(ledger) {
      const bulk = claimOf();
      const claimId = owned(await ledger.claim(bulk, AT));
      expect(await ledger.settle(bulk, 'sent', AT, claimId)).toBe(true);
      expect(await ledger.settle(bulk, 'failed', AT, claimId)).toBe(false);
      expect(await ledger.find(bulk)).toMatchObject({ status: 'sent' });
    },
  },
  {
    name: 'a failed delivery is re-claimable at once, counting the attempt',
    async run(ledger) {
      const bulk = claimOf();
      await ledger.settle(bulk, 'failed', AT, owned(await ledger.claim(bulk, AT)));
      owned(await ledger.claim({ ...bulk, recipient: '' }, AT));
      expect(await ledger.find(bulk)).toMatchObject({
        recipient: null,
        status: 'sending',
        attempts: 2,
      });
    },
  },
  {
    name: 'two recipients of one notification are two deliveries',
    async run(ledger) {
      const base = claimOf();
      const ana = { ...base, recipient: 'ana' };
      await ledger.settle(ana, 'sent', AT, owned(await ledger.claim(ana, AT)));
      owned(await ledger.claim({ ...base, recipient: 'ben' }, AT));
      expect(await ledger.claim(ana, AT)).toEqual({ outcome: 'sent' });
    },
  },
];
