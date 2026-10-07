// What a row is on the far side of the bus. The publisher holds repository values and the bus
// carries text; these pin that the sync node gets the values back, by the column that declared them.

import { describe, expect, test } from 'bun:test';
import { bytes, entity, entityForTable, text, timestamp } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import type { Row } from './json';
import { parseEnvelope } from './replicator-envelope';
import { busRow, reviveBusRow } from './replicator-row';

function ensureBlobs(): void {
  if (entityForTable('bus_blobs') !== undefined) return;
  entity('bus_blobs', {
    columns: {
      id: text().primaryKey(),
      note: text(),
      body: bytes().nullable(),
      seenAt: timestamp().nullable(),
    },
  });
}

const asRow = (value: Record<string, unknown>): Row => value as unknown as Row;

/** The whole hop: what the replicator stringifies, then what the node parses. */
const across = (change: ChangeEvent): ChangeEvent | undefined =>
  parseEnvelope(
    JSON.stringify({
      ...change,
      before: busRow(change.before),
      after: busRow(change.after),
      seq: 1,
      producer: 'r1',
    }),
  )?.change;

const change = (after: Record<string, unknown>, over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  table: 'bus_blobs',
  op: 'update',
  before: null,
  after: asRow(after),
  lsn: '0000000000000001',
  txid: '1',
  orgId: null,
  at: 0,
  write: null,
  ...over,
});

describe('a row across the replicator bus', () => {
  test('bytes arrive as bytes, a timestamp as a Date', () => {
    ensureBlobs();
    const payload = new Uint8Array(70_000).map((_, at) => at % 251);
    const seenAt = new Date('2026-08-09T12:00:00.123Z');
    const after = across(change({ id: 'b1', note: 'n', body: payload, seenAt }))?.after;

    const body = (after as Record<string, unknown> | null | undefined)?.['body'];
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body).toEqual(payload);
    expect((after as Record<string, unknown>)['seenAt']).toEqual(seenAt);
  });

  test('a text column that happens to hold an ISO instant stays text', () => {
    ensureBlobs();
    const after = across(change({ id: 'b1', note: '2026-08-09T12:00:00.000Z' }))?.after;
    expect(after?.['note']).toBe('2026-08-09T12:00:00.000Z');
  });

  test('a null stays null, and a property the entity never declared is kept as it came', () => {
    ensureBlobs();
    const after = across(change({ id: 'b1', note: 'n', body: null, extra: { a: 1 } }))?.after;
    expect(after).toEqual({ id: 'b1', note: 'n', body: null, extra: { a: 1 } });
  });

  test('a table with no entity on this node crosses unrevived rather than being dropped', () => {
    const row = { id: 'x', at: '2026-08-09T12:00:00.000Z' };
    expect(reviveBusRow('no_such_table', asRow(row))).toEqual(row);
  });

  test('a value its column refuses is kept, never the reason a change is lost', () => {
    ensureBlobs();
    const after = across(change({ id: 'b1', note: 'n', seenAt: 'not an instant' }))?.after;
    expect(after?.['seenAt']).toBe('not an instant');
    expect(after?.['note']).toBe('n');
  });

  test('the properties a change could not carry cross with it', () => {
    ensureBlobs();
    const sent = change({ id: 'b1', note: 'n' }, { omitted: ['body'] });
    expect(across(sent)?.omitted).toEqual(['body']);
    // Only the shape the publisher mints: a list of names. Anything else is not forwarded.
    for (const malformed of [[], 'body', [1], null]) {
      const decoded = parseEnvelope(
        JSON.stringify({ ...sent, omitted: malformed, seq: 1, producer: 'r1' }),
      )?.change;
      expect(Object.hasOwn(decoded ?? {}, 'omitted')).toBe(false);
    }
  });
});
