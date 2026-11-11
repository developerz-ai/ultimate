// A window no read has landed in yet owes a second read only for a change to a table it READS.
// Any change on the node used to stale it, so every new window on a busy node read twice and
// re-snapshotted every subscriber.

import { describe, expect, test } from 'bun:test';
import { systemClock } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import type { JsonValue } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveEntries } from './live-entries';
import { type FanoutDeps, fanoutChange } from './live-fanout';
import { type QueryEntry, queryEntry } from './query-window';
import { SubscriberGate } from './subscriber-gate';

const input: JsonValue = { orgId: 'o1' };

/** A window on `posts` whose first read is still out: `applied === 0`. */
function coldEntry(): { entry: QueryEntry; reads: () => number } {
  let reads = 0;
  const definition: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: async () => {
      reads += 1;
      return { rows: [], lsn: '' };
    },
    visible: () => true,
    matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
  };
  const entry = queryEntry('liveFeed:1', definition, input, definition.matcher(input));
  return { entry, reads: () => reads };
}

const deps: FanoutDeps = {
  gate: new SubscriberGate({}),
  source: new RingChangeBuffer(),
  clock: systemClock,
};

const changeOn = (table: string): ChangeEvent => ({
  table,
  op: 'update',
  before: { id: 'c1', orgId: 'o1' },
  after: { id: 'c1', orgId: 'o1' },
  lsn: '9',
  txid: '9',
  at: 0,
  orgId: 'o1',
  write: null,
});

describe('a cold window', () => {
  test('a change on a table it does not read leaves it fresh: no second read owed', async () => {
    const { entry, reads } = coldEntry();
    expect(await fanoutChange(deps, entry, changeOn('comments'))).toEqual({ sent: 0, stale: 0 });
    expect(entry.stale).toBe(false);
    expect(reads()).toBe(0);
  });

  test('a change on a table it reads still marks it, so the landing read is followed by one', async () => {
    const { entry } = coldEntry();
    await fanoutChange(deps, entry, changeOn('posts'));
    expect(entry.stale).toBe(true);
  });

  test('is not even a target of a change to another table', () => {
    const entries = new LiveEntries({ source: new RingChangeBuffer() });
    const { entry } = coldEntry();
    entries.add(entry);
    expect(entries.targets('comments')).toEqual([]);
    expect(entries.targets('posts')).toEqual([entry]);
  });
});
