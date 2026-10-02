// An ISO instant handed to a `timestamptz` column as TEXT, on both drivers. Postgres parses the
// bound parameter as an instant; the in-memory driver compared it to the stored `Date` by
// CHARACTERS — `String(date)` against `2026-…` — so a hand-kept keyset (`createdAt lt <the last
// row's instant>`) answered an empty page two in memory and the right one in production.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { instantMicros } from './instant';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const events = entity('instant_text_events', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 20 }),
    createdAt: timestamp(),
  },
});
type Event = typeof events.$row;

const idAt = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const at = (second: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, second));

/** Five rows, one second apart: `e1` is the oldest. */
const SEED: readonly Event[] = [1, 2, 3, 4, 5].map((n) => ({
  id: idAt(n),
  label: `e${String(n)}`,
  createdAt: at(n),
}));

let client: RecordingClient;
beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});
afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const newestFirst = [{ column: 'createdAt', direction: 'desc' as const }];
const labels = (rows: readonly Event[]): readonly string[] => rows.map((row) => row.label);

describe('a timestamptz compared against ISO text, as Postgres parses it', () => {
  test('instantMicros reads an ISO instant that names its zone, to the microsecond', () => {
    const micros = BigInt(at(3).getTime()) * 1000n;
    expect(instantMicros('2026-01-01T00:00:03.000Z')).toBe(micros);
    expect(instantMicros('2026-01-01T00:00:03Z')).toBe(micros);
    expect(instantMicros('2026-01-01 00:00:03+00')).toBe(micros);
    // An offset is part of the instant: 02:00:03 at +02:00 is the same moment.
    expect(instantMicros('2026-01-01T02:00:03+02:00')).toBe(micros);
    expect(instantMicros('2025-12-31T19:30:03-0430')).toBe(micros);
    // Six fraction digits are the column's own precision, and they survive.
    expect(instantMicros('2026-01-01T00:00:03.000001Z')).toBe(micros + 1n);
    expect(instantMicros('2026-01-01T00:00:03.5Z')).toBe(micros + 500_000n);
  });

  // Every expectation below is what Postgres 17 answered for `'<text>'::timestamptz`, 2026-10-01.
  test('a fraction past six digits is ROUNDED to the microsecond, carrying into the second', () => {
    const micros = BigInt(at(3).getTime()) * 1000n;
    expect(instantMicros('2026-01-01T00:00:03.0000009Z')).toBe(micros + 1n);
    expect(instantMicros('2026-01-01T00:00:03.0000015Z')).toBe(micros + 2n);
    // Postgres rounds the DOUBLE `strtod` reads, and 0.0000005 is a hair under the half.
    expect(instantMicros('2026-01-01T00:00:03.0000005Z')).toBe(micros);
    expect(instantMicros('2026-01-01T00:00:02.9999996Z')).toBe(micros);
    expect(instantMicros('2026-12-31T23:59:59.9999995Z')).toBe(
      BigInt(Date.UTC(2027, 0, 1)) * 1000n,
    );
  });

  test('an offset of sixteen hours or more, or of sixty minutes, is no instant', () => {
    const midnight = BigInt(Date.UTC(2026, 0, 1)) * 1000n;
    expect(instantMicros('2026-01-01T00:00:00+15:59')).toBe(midnight - 959n * 60_000_000n);
    expect(instantMicros('2026-01-01T00:00:00-15:59')).toBe(midnight + 959n * 60_000_000n);
    expect(instantMicros('2026-01-01T00:00:00+16:00')).toBeUndefined();
    expect(instantMicros('2026-01-01T00:00:00-16')).toBeUndefined();
    expect(instantMicros('2026-01-01T00:00:00+00:60')).toBeUndefined();
    expect(instantMicros('2026-01-01T00:00:00+0260')).toBeUndefined();
  });

  test('24:00:00 is the next midnight and :60 the next minute; nothing past the day is', () => {
    const day = (d: number): bigint => BigInt(Date.UTC(2026, 0, d)) * 1000n;
    expect(instantMicros('2026-01-01T24:00:00Z')).toBe(day(2));
    expect(instantMicros('2026-01-01T24:00:00.0000004Z')).toBe(day(2));
    expect(instantMicros('2026-01-01T23:59:60Z')).toBe(day(2));
    expect(instantMicros('2026-02-28T24:00:00Z')).toBe(BigInt(Date.UTC(2026, 2, 1)) * 1000n);
    expect(instantMicros('2026-12-31T24:00:00+02:00')).toBe(
      BigInt(Date.UTC(2026, 11, 31, 22)) * 1000n,
    );
    expect(instantMicros('2026-01-01T12:30:60.5Z')).toBe(
      BigInt(Date.UTC(2026, 0, 1, 12, 31)) * 1000n + 500_000n,
    );
    expect(instantMicros('2026-01-01T00:00:60.9999996Z')).toBe(
      BigInt(Date.UTC(2026, 0, 1, 0, 1, 1)) * 1000n,
    );
    for (const past of [
      '2026-01-01T24:00:00.000001Z',
      '2026-01-01T24:00:01Z',
      '2026-01-01T24:00:60Z',
      '2026-01-01T23:59:60.5Z',
      '2026-01-01T23:59:60.9999996Z',
      '2026-01-01T23:60:00Z',
      '2026-01-01T25:00:00Z',
      '2026-01-01T12:00:61Z',
      '2026-02-29T00:00:00Z',
    ]) {
      expect(instantMicros(past)).toBeUndefined();
    }
  });

  test('a text with no zone, or that is no instant, is not guessed at', () => {
    // Postgres reads a zoneless text in the SESSION's zone, which this process cannot know.
    expect(instantMicros('2026-01-01T00:00:03')).toBeUndefined();
    expect(instantMicros('yesterday')).toBeUndefined();
    expect(instantMicros('2026-13-45T00:00:00Z')).toBeUndefined();
    // A decimal is still a microsecond count: what a cursor carries.
    expect(instantMicros('1767225603000000')).toBe(1_767_225_603_000_000n);
  });

  test('memory: page two of a keyset over an instant sort is the older rows, not an empty page', async () => {
    const memory = memoryRepo(events, SEED);
    const first = await memory.findMany({ orderBy: newestFirst, limit: 2 });
    expect(labels(first.rows)).toEqual(['e5', 'e4']);
    // The position a caller keeps: the last row's instant, as the text a URL or a JSON body holds.
    const after = first.rows.at(-1)?.createdAt.toISOString();
    const second = await memory.findMany({
      where: [{ column: 'createdAt', op: 'lt', value: after }],
      orderBy: newestFirst,
      limit: 2,
    });
    expect(labels(second.rows)).toEqual(['e3', 'e2']);
  });

  test('memory: every comparison reads the text as the instant it names', async () => {
    const memory = memoryRepo(events, SEED);
    const where = async (op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', value: string) =>
      labels(
        (
          await memory.findMany({
            where: [{ column: 'createdAt', op, value }],
            orderBy: newestFirst,
          })
        ).rows,
      );
    expect(await where('eq', '2026-01-01T00:00:03.000Z')).toEqual(['e3']);
    // The same instant under another offset is the same row.
    expect(await where('eq', '2026-01-01T01:00:03+01:00')).toEqual(['e3']);
    expect(await where('neq', '2026-01-01T00:00:03Z')).toEqual(['e5', 'e4', 'e2', 'e1']);
    expect(await where('gte', '2026-01-01T00:00:04Z')).toEqual(['e5', 'e4']);
    expect(await where('gt', '2026-01-01T00:00:04Z')).toEqual(['e5']);
    expect(await where('lte', '2026-01-01T00:00:02Z')).toEqual(['e2', 'e1']);
  });

  test('postgres: the same call binds the text to the column, and the server parses the instant', async () => {
    const after = at(4).toISOString();
    await postgresRepo(events).findMany({
      where: [{ column: 'createdAt', op: 'lt', value: after }],
      orderBy: newestFirst,
      limit: 2,
    });
    const sent = client.texts.at(-1) ?? '';
    expect(sent).toContain('"created_at" < $1');
    expect(client.statements.at(-1)?.values[0]).toBe(after);
  });
});
