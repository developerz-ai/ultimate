// Both subscription caps refused when they are not finite numbers, at the moment the book is
// built rather than at the moment a subscribe reads them.
//
// Failure case first: `maxPerTenant` was read raw, two lines below the screened `maxPerSocket`.
// `count >= NaN` is false, so the ONLY cap that spans the sockets of one tenant was off — and
// nothing said so. Measured before the fix: a book capped at `maxPerTenant: NaN` admitted every
// one of 5,000 subscribes for one tenant, which is the walk this book's own header calls "one
// authenticated socket consuming the node".

import { describe, expect, test } from 'bun:test';
import { type Actor, UltimateError, userActor } from '@ultimat3/core';
import { SubscriptionLimitError } from './errors';
import type { LiveSubscription } from './live-contract';
import { SyncSocket, type WsLike } from './socket';
import { SubscriptionBook } from './subscription-book';

const ws: WsLike = {
  send: () => 1,
  close: () => undefined,
  subscribe: () => undefined,
  unsubscribe: () => undefined,
  getBufferedAmount: () => 0,
};

/** Every shape `Number(process.env.X)` / `parseInt` / a JSON `null` hands a config reader. */
const NOT_A_CAP = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const tenantOf = (actor: Actor | null): string | null => actor?.orgId ?? null;

function socketFor(id: string, actor: Actor | null): SyncSocket {
  return new SyncSocket({ ws, id, clientBuildId: 'b', serverBuildId: 'b', actor });
}

function subscriptionFor(socket: SyncSocket, sid: string): LiveSubscription {
  return {
    sid,
    qid: `q:${sid}`,
    socket,
    input: null,
    definition: {
      name: 'q',
      entities: [],
      snapshot: async () => ({ rows: [], lsn: '' }),
      visible: () => true,
      matcher: () =>
        ({ affects: () => false, apply: () => ({ patches: [], refill: false }) }) as never,
    },
    cursor: { qid: `q:${sid}`, lsn: '', ids: [], at: 0 },
  };
}

describe('a subscription book built on a cap that is not a number', () => {
  test('a non-finite maxPerTenant is refused, because the cap spanning sockets would be off', () => {
    for (const maxPerTenant of NOT_A_CAP) {
      expect(() => new SubscriptionBook({ maxPerTenant, tenantOf })).toThrow(UltimateError);
    }
  });

  test('a non-finite maxPerSocket is refused at construction, not at the first subscribe', () => {
    // It WAS screened — inside `assertCapacity`, so a misconfigured node built its book, held it
    // for the life of the process and refused on the subscribe path instead of at boot.
    for (const maxPerSocket of NOT_A_CAP) {
      expect(() => new SubscriptionBook({ maxPerSocket })).toThrow(UltimateError);
    }
  });

  test('the refusal names the option and the value, so it is one edit', () => {
    let thrown: unknown;
    try {
      new SubscriptionBook({ maxPerTenant: Number.NaN, tenantOf });
    } catch (error: unknown) {
      thrown = error;
    }
    const rendered = thrown instanceof UltimateError ? `${thrown.cause} ${thrown.fix}` : '';
    expect(rendered).toContain('maxPerTenant');
    expect(rendered).toContain('NaN');
  });
});

describe('the caps a book is legitimately given', () => {
  test('a finite maxPerTenant still refuses across two sockets of one tenant', () => {
    // Non-vacuity for the whole file: a constructor that threw on everything, or a cap that never
    // refused, would satisfy the refusals above.
    const book = new SubscriptionBook({ maxPerTenant: 2, tenantOf });
    const alice = socketFor('s1', userActor({ id: 'alice', orgId: 'o1' }));
    const bob = socketFor('s2', userActor({ id: 'bob', orgId: 'o1' }));
    book.add(subscriptionFor(alice, 'a'));
    book.add(subscriptionFor(bob, 'b'));
    expect(() => book.assertCapacity(bob)).toThrow(SubscriptionLimitError);
  });

  test('an omitted maxPerTenant is still NO cap — undefined never became a screened number', () => {
    const book = new SubscriptionBook({ tenantOf });
    const alice = socketFor('s1', userActor({ id: 'alice', orgId: 'o1' }));
    for (let index = 0; index < 200; index += 1) {
      book.add(subscriptionFor(socketFor(`s${index}`, alice.actor), `sid${index}`));
    }
    expect(book.tenantCount('o1')).toBe(200);
    expect(() => book.assertCapacity(alice)).not.toThrow();
  });

  test('maxPerTenant: 0 still means refuse every subscribe — a finite zero is a decision', () => {
    // The screen must not acquire a `min: 1` on the way in: zero is a caller telling this node to
    // hold no live subscriptions for a tenanted socket, and refusing it at boot is an outage.
    const book = new SubscriptionBook({ maxPerTenant: 0, tenantOf });
    const alice = socketFor('s1', userActor({ id: 'alice', orgId: 'o1' }));
    expect(() => book.assertCapacity(alice)).toThrow(SubscriptionLimitError);
  });

  test('maxPerSocket: 0 still means refuse every subscribe', () => {
    const book = new SubscriptionBook({ maxPerSocket: 0 });
    expect(() => book.assertCapacity(socketFor('s1', null))).toThrow(SubscriptionLimitError);
  });
});
