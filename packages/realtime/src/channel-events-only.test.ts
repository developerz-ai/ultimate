// An events-only channel names no catch-up read: without `records` nothing is replayed, so the read
// never runs. `channelRef('feed', { params })` declares it; a gap on it restarts the cursor with no
// read; a server half that adds `records` to a ref with no read is refused where it is written.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, entity, uuid } from '@ultimat3/entity';
import { channel } from './channel-decl';
import { catchUpReadOf, channelRef } from './channel-ref';
import { clearChannels } from './channel-registry';
import { ChannelBook } from './client-channels';
import { OPEN_POLICY } from './policy-fake-fixture';
import { RecordStore } from './record-store';
import { PROTOCOL_VERSION } from './sync-protocol';

const rows = entity('events_only_rows', { columns: { id: uuid().primaryKey(), orgId: uuid() } });

afterAll(() => {
  clearChannels();
  clearRegistry();
});

describe('an events-only channel ref', () => {
  test('declares with params alone, and answers no catch-up name', () => {
    const feed = channelRef('typing-feed', { params: ['orgId'] });
    expect(feed.catchUp).toBe('');
    expect(String(feed.topic({ orgId: 'o1' }))).toBe('typing-feed.o1');
    const declared = channel(feed, { policy: OPEN_POLICY, events: true });
    expect(declared.events).toBe(true);
  });

  test('a gap on it reads nothing and goes live', async () => {
    const feed = channelRef('typing-gap', { params: ['orgId'] });
    const reads: string[] = [];
    const book = new ChannelBook({
      store: new RecordStore(),
      send: () => undefined,
      connected: () => true,
      catchUp: async (name) => {
        reads.push(name);
        return undefined;
      },
      report: () => undefined,
    });
    const membership = book.hold(feed, { orgId: 'o1' });
    book.gap({ type: 'replay-gap', v: PROTOCOL_VERSION, channel: 'typing-gap.o1', epoch: 'e1' });
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(reads).toEqual([]);
    expect(membership.state()).toBe('live');
  });

  test('records on a ref with no catch-up read are refused at declaration', () => {
    const feed = channelRef('typing-records', { params: ['orgId'] });
    let caught: unknown;
    try {
      channel(feed, { policy: OPEN_POLICY, records: [rows] });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) ? caught.code : String(caught)).toBe(
      'X_CHANNEL_DECLARATION_INVALID',
    );
    expect(isUltimateError(caught) ? caught.cause : '').toContain('names no catchUp read');
  });
});

test('a catch-up query not yet named (stamped at boot) still carries records', () => {
  const read = { name: '' };
  const feed = channelRef('typing-unnamed', { params: ['orgId'], catchUp: read });
  expect(channel(feed, { policy: OPEN_POLICY, records: [rows] }).records).toHaveLength(1);
  expect(catchUpReadOf(feed)).toBe(read);
});
