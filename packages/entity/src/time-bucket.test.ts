// Single responsibility: `series` buckets a row where Postgres' three-argument `date_trunc` buckets
// it, on BOTH drivers — memory and PGlite, the same rows, compared to instants written out by hand
// so neither driver can be right only because the other is wrong. The zone cases are the ones a
// session-zone `date_trunc` gets wrong: a 23-hour day, a Tokyo midnight, a repeated hour, a
// half-hour zone, a midnight that happens twice.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, money, text, timestamp, uuid } from './columns';
import { MAX_GROUPS } from './count-by';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresDriver } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { bucketStart, SERIES_UNITS } from './time-bucket';
import { BUCKET_CASES } from './time-bucket-fixture';

const PGLITE_BOOT_MS = 30_000;

const events = entity('tb_events', {
  columns: {
    id: uuid().primaryKey(),
    kind: text({ max: 20 }),
    at: timestamp().nullable(),
    weight: integer(),
    amount: money(),
  },
});
type Event = typeof events.$row;

const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [events.$describe()],
    name: 'time bucket parity',
    now: new Date('2026-11-06T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "tb_events"'));
  // A session zone that is NOT the series zone: a dropped zone argument answers in this one.
  await client.execute(raw("set time zone 'Pacific/Auckland'"));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

let serial = 0;
const row = (at: string | null, over: Partial<Event> = {}): Event => {
  serial += 1;
  return {
    id: `00000000-0000-7000-8000-${String(serial).padStart(12, '0')}`,
    kind: 'view',
    at: at === null ? null : new Date(at),
    weight: 1,
    amount: { minor: 100, currency: 'EUR' },
    ...over,
  };
};

const seeded = async (driver: Driver, rows: readonly Event[]) => {
  const db = database({ events }, { driver });
  await db.events.insertAll(rows);
  return db.events;
};

/** The same rows into both drivers, the same call on each: [memory, pglite]. */
const both = async <T>(
  rows: readonly Event[],
  ask: (table: Awaited<ReturnType<typeof seeded>>) => Promise<T>,
): Promise<readonly [T, T]> => {
  const memory = await ask(await seeded(memoryDriver(), rows));
  const pg = await ask(await seeded(postgresDriver(), rows));
  return [memory, pg];
};

const iso = (points: readonly { readonly bucket: Date; readonly value: unknown }[]) =>
  points.map((point) => [point.bucket.toISOString(), point.value]);

describe('series: one bucket per zone rule, on both drivers', () => {
  for (const each of BUCKET_CASES) {
    test(
      each.name,
      async () => {
        const [memory, pg] = await both(
          each.at.map((at) => row(at)),
          (table) =>
            table.series({ on: 'at', unit: each.unit, timeZone: each.zone, value: 'count' }),
        );
        expect(iso(memory)).toEqual(each.want.map(([at, count]) => [at, count]));
        expect(iso(pg)).toEqual(iso(memory));
      },
      PGLITE_BOOT_MS,
    );
  }

  test('a spring-forward day has 23 hourly buckets', async () => {
    // Every 20 minutes across the local day of 2026-03-08 in New York: 05:00Z to 04:00Z next day.
    const rows = Array.from({ length: 23 * 3 }, (_, index) =>
      row(new Date(Date.parse('2026-03-08T05:00:00.000Z') + index * 20 * 60_000).toISOString()),
    );
    const [memory, pg] = await both(rows, (table) =>
      table.series({ on: 'at', unit: 'hour', timeZone: 'America/New_York', value: 'count' }),
    );
    expect(memory).toHaveLength(23);
    expect(memory.every((point) => point.value === 3)).toBe(true);
    expect(iso(pg)).toEqual(iso(memory));
  });

  test(
    'every unit agrees with Postgres across a DST week, in five zones',
    async () => {
      // Every 97 minutes across both 2026 transitions' weeks: an irregular step, so buckets start
      // and end on every kind of boundary.
      const starts = ['2026-03-26T00:00:00.000Z', '2026-10-21T00:00:00.000Z'];
      const rows = starts.flatMap((start) =>
        Array.from({ length: 110 }, (_, index) =>
          row(new Date(Date.parse(start) + index * 97 * 60_000).toISOString()),
        ),
      );
      const memory = await seeded(memoryDriver(), rows);
      const pg = await seeded(postgresDriver(), rows);
      for (const zone of ['Europe/Berlin', 'America/Santiago', 'Australia/Lord_Howe', 'UTC']) {
        for (const unit of SERIES_UNITS) {
          const spec = { on: 'at', unit, timeZone: zone, value: 'count' } as const;
          expect({ zone, unit, points: iso(await pg.series(spec)) }).toEqual({
            zone,
            unit,
            points: iso(await memory.series(spec)),
          });
        }
      }
    },
    PGLITE_BOOT_MS,
  );
});

describe('series: what a bucket holds', () => {
  test('a sum is decimal text, money a MoneyValue, and a row with no instant is in no bucket', async () => {
    const rows = [
      row('2026-05-01T10:00:00.000Z', { weight: 2, amount: { minor: 150, currency: 'EUR' } }),
      row('2026-05-01T11:00:00.000Z', { weight: 3, amount: { minor: 250, currency: 'EUR' } }),
      row('2026-05-02T11:00:00.000Z', { weight: 5, amount: { minor: 1, currency: 'EUR' } }),
      row(null, { weight: 100 }),
    ];
    const spec = { on: 'at', unit: 'day', timeZone: 'UTC' } as const;
    const [memory, pg] = await both(rows, async (table) => [
      iso(await table.series({ ...spec, value: { sum: 'weight' } })),
      iso(await table.series({ ...spec, value: { sum: 'amount' } })),
      iso(await table.series({ ...spec, value: 'count' })),
    ]);
    expect(memory).toEqual([
      [
        ['2026-05-01T00:00:00.000Z', '5'],
        ['2026-05-02T00:00:00.000Z', '5'],
      ],
      [
        ['2026-05-01T00:00:00.000Z', { minor: 400, currency: 'EUR' }],
        ['2026-05-02T00:00:00.000Z', { minor: 1, currency: 'EUR' }],
      ],
      [
        ['2026-05-01T00:00:00.000Z', 2],
        ['2026-05-02T00:00:00.000Z', 1],
      ],
    ]);
    expect(pg).toEqual(memory);
  });

  test("the chain's filters bound the rows", async () => {
    const rows = [
      row('2026-05-01T10:00:00.000Z', { kind: 'view' }),
      row('2026-05-01T10:00:00.000Z', { kind: 'like' }),
    ];
    const [memory, pg] = await both(rows, (table) =>
      table
        .where({ kind: 'like' })
        .series({ on: 'at', unit: 'day', timeZone: 'UTC', value: 'count' }),
    );
    expect(iso(memory)).toEqual([['2026-05-01T00:00:00.000Z', 1]]);
    expect(iso(pg)).toEqual(iso(memory));
  });

  test('two currencies in one series are refused on both drivers', async () => {
    const rows = [
      row('2026-05-01T10:00:00.000Z', { amount: { minor: 1, currency: 'EUR' } }),
      row('2026-05-03T10:00:00.000Z', { amount: { minor: 1, currency: 'JPY' } }),
    ];
    for (const driver of [memoryDriver(), postgresDriver()]) {
      const table = await seeded(driver, rows);
      await expect(
        table.series({ on: 'at', unit: 'day', timeZone: 'UTC', value: { sum: 'amount' } }),
      ).rejects.toBeUltimateError('X_AGGREGATE_MIXED_CURRENCY');
    }
  });
});

describe('series: refusals', () => {
  test(
    `one bucket past MAX_GROUPS (${MAX_GROUPS}) is refused, never truncated`,
    async () => {
      const rows = Array.from({ length: MAX_GROUPS + 1 }, (_, index) =>
        row(new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000).toISOString()),
      );
      for (const driver of [memoryDriver(), postgresDriver()]) {
        const table = await seeded(driver, rows);
        await expect(
          table.series({ on: 'at', unit: 'minute', timeZone: 'UTC', value: 'count' }),
        ).rejects.toBeUltimateError('X_ENTITY_SERIES_INVALID');
        const wider = await table.series({
          on: 'at',
          unit: 'hour',
          timeZone: 'UTC',
          value: 'count',
        });
        expect(wider.reduce((total, point) => total + point.value, 0)).toBe(MAX_GROUPS + 1);
      }
    },
    PGLITE_BOOT_MS,
  );

  const bad: readonly (readonly [string, Record<string, unknown>])[] = [
    ['an unknown unit', { unit: 'fortnight' }],
    ['a column that is not a timestamp', { on: 'kind' }],
    ['a column the entity does not declare', { on: 'nope' }],
    ['a zone that is not IANA', { timeZone: 'Mars/Olympus' }],
    ['an offset in place of a zone', { timeZone: '+02:00' }],
  ];
  for (const [name, over] of bad) {
    test(`${name} is X_ENTITY_SERIES_INVALID on both drivers`, async () => {
      for (const driver of [memoryDriver(), postgresDriver()]) {
        const table = await seeded(driver, []);
        const spec = { on: 'at', unit: 'day', timeZone: 'UTC', value: 'count', ...over };
        await expect(
          table.series(spec as Parameters<typeof table.series>[0]),
        ).rejects.toBeUltimateError('X_ENTITY_SERIES_INVALID');
      }
    });
  }

  test('a sum over a column with no sum is the aggregate refusal', async () => {
    const table = await seeded(memoryDriver(), []);
    await expect(
      table.series({
        on: 'at',
        unit: 'day',
        timeZone: 'UTC',
        value: { sum: 'kind' } as unknown as { sum: 'weight' },
      }),
    ).rejects.toBeUltimateError('X_AGGREGATE_UNSUPPORTED');
  });

  test('a hand-written Repo without series is X_ENTITY_SERIES_UNSUPPORTED', async () => {
    const { series: _omitted, ...handWritten } = memoryRepo(events);
    const table = tableFor(events, handWritten as Repo<Event>);
    await expect(
      table.series({ on: 'at', unit: 'day', timeZone: 'UTC', value: 'count' }),
    ).rejects.toBeUltimateError('X_ENTITY_SERIES_UNSUPPORTED');
  });
});

describe('bucketStart', () => {
  test('is the one truncation the memory driver reads', () => {
    expect(bucketStart(new Date('2026-03-31T23:30:00.000Z'), 'day', 'Asia/Tokyo')).toEqual(
      new Date('2026-03-31T15:00:00.000Z'),
    );
  });
});

describe('series: the type refuses what the runtime refuses', () => {
  test('on is a timestamp column, a count is a number, a money sum a MoneyValue', async () => {
    const table = await seeded(memoryDriver(), []);
    const counts = await table.series({ on: 'at', unit: 'day', timeZone: 'UTC', value: 'count' });
    const total: number | undefined = counts[0]?.value;
    const sums = await table.series({
      on: 'at',
      unit: 'day',
      timeZone: 'UTC',
      value: { sum: 'amount' },
    });
    const minor: number | undefined = sums[0]?.value?.minor;
    expect([total, minor]).toEqual([undefined, undefined]);
    const wrong = () =>
      // @ts-expect-error — `kind` is a text column, and a bucket is a span of instants
      table.series({ on: 'kind', unit: 'day', timeZone: 'UTC', value: 'count' });
    const unit = () =>
      // @ts-expect-error — the unit list is closed
      table.series({ on: 'at', unit: 'fortnight', timeZone: 'UTC', value: 'count' });
    expect([typeof wrong, typeof unit]).toEqual(['function', 'function']);
  });
});
