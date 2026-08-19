// The id a live query is keyed by is `@ultimat3/query`'s `queryHash`, and this package derives
// none of its own. It used to: `qidOf(name, input)` was `` `${name}:${stableDigest(canonicalJson(
// input))}` `` over this package's own copy of the canonical form, byte-identical to `queryHash`
// on every ordinary input and already disagreeing on an `undefined`-valued key.
//
// The two are COMPARED in one flow, which is why one of them had to go rather than both being
// kept correct: `@ultimat3/query`'s `planResume` decides refetch-vs-resume by comparing a cursor's
// `queryHash` against the query's, while the shared window an entry seats is keyed by the qid. Two
// derivations means every resume decision and every window lookup keyed differently the first time
// either one moves.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { queryHash } from '@ultimat3/query';
import { formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { SyncSocket, type WsLike } from './socket';

class SilentWs implements WsLike {
  send(data: string): number {
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const rows: readonly Row[] = [{ id: 'p1', orgId: 'o1' }];

const definition: LiveQueryDefinition = {
  name: 'liveFeed',
  entities: ['post'],
  snapshot: async () => await Promise.resolve({ rows, lsn: formatLsn(1) }),
  visible: () => true,
  matcher: () => ({ entities: ['post'], match: () => ({ patches: [], refill: false }) }),
};

const registryWith = (): LiveQueryRegistry => {
  const registry = new LiveQueryRegistry({
    source: { snapshot: async () => await Promise.resolve([]) },
  });
  registry.register(definition);
  return registry;
};

const subscribed = async (input: JsonValue, sid: string): Promise<LiveQueryRegistry> => {
  const registry = registryWith();
  const socket = new SyncSocket({
    ws: new SilentWs(),
    id: `sock-${sid}`,
    clientBuildId: 'b1',
    serverBuildId: 'b1',
    actor: userActor({ id: 'alice', orgId: 'o1' }),
  });
  await registry.subscribe({ socket, name: 'liveFeed', input, sid });
  return registry;
};

describe('the qid a subscription is seated under is queryHash, not a local derivation', () => {
  test('the registry answers a subscriber count under the query package own hash', async () => {
    const input: JsonValue = { orgId: 'o1', limit: 50 };
    const registry = await subscribed(input, 'sid-1');
    expect(registry.subscriberCount(queryHash('liveFeed', input))).toBe(1);
  });

  test('key order is not identity, and neither the name nor the input is dropped from it', async () => {
    const registry = await subscribed({ limit: 50, orgId: 'o1' }, 'sid-2');
    // The same input, spelled the other way round: one window, because the hash sorts keys.
    expect(registry.subscriberCount(queryHash('liveFeed', { orgId: 'o1', limit: 50 }))).toBe(1);
    expect(registry.subscriberCount(queryHash('liveFeed', { orgId: 'o2', limit: 50 }))).toBe(0);
    expect(registry.subscriberCount(queryHash('otherFeed', { orgId: 'o1', limit: 50 }))).toBe(0);
  });
});
