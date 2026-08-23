// One row, two surfaces. A WAL tuple decoded by `pg-values.ts` and folded by `entityRow`, and the
// same physical row read back through `@ultimat3/entity`'s repository, must produce the IDENTICAL
// object — a live subscriber and a refetch reporting different shapes for one row is the bug this
// file exists to catch. `@ultimat3/entity` is tier 2, a legal downward import, and this file never
// ships: `*.test.ts` is excluded from the tarball. Comparing against the real reader is the point —
// a hand-written expectation of what it "would" produce is the copy that drifts.
//
// **The two sides are fed DIFFERENT inputs on purpose, and that is the whole of the rewrite.**
// Handing `entityRow` and the repository one object could only ever catch a difference in the
// FOLD; it could not see a wire-format one, which is what shipped: `tags` was `"{a,b}"` live and
// `["a","b"]` through the repo, `createdAt` was `"2026-08-09 12:00:00+00"` live and a `Date`
// through the repo. So the repository gets the value its DRIVER hands back and `entityRow` gets
// the text the WAL carries, decoded by its own type oid.

import { afterAll, expect, test } from 'bun:test';
import {
  arrayOf,
  bytes,
  clearRegistry,
  entity,
  money,
  postgresRepo,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { entityRow } from './pg-entity-row';
import { decodeValue, type PhysicalValue } from './pg-values';

const PRODUCT_ID = '0192f0c0-0000-7000-8000-000000000001';

const products = entity('realtime_parity_products', {
  columns: {
    id: uuid().primaryKey(),
    title: text(),
    tags: arrayOf(text()),
    thumbnail: bytes(),
    publishedAt: timestamp(),
    price: money(),
  },
});

afterAll(() => {
  // The registry is process-global; a leaked entry breaks an unrelated package's tests.
  clearRegistry();
});

/**
 * One physical column, said twice: as postgres writes it on the WAL, and as the driver hands it
 * back on a `select`. A `Cell` with one `wal` and one `driver` is what makes a wire-format
 * divergence expressible at all.
 */
interface Cell {
  readonly oid: number;
  /** The pgoutput text-format value, or `null` for a NULL column. */
  readonly wal: string | null;
  /** What Bun's `sql` / PGlite return for that same column. */
  readonly driver: unknown;
}

const OID = {
  uuid: 2950,
  text: 25,
  textArray: 1009,
  bytea: 17,
  timestamptz: 1184,
  int8: 20,
  bpchar: 1042,
  int4: 23,
} as const;

/**
 * The narrowest `DbClient` a point read needs. Typed structurally rather than imported:
 * `@ultimat3/db` is not a dependency of this package, and the row is all the repository reads.
 */
const clientOver = (row: Readonly<Record<string, unknown>>) => {
  // Held as `unknown`: `DbClient.query<T>`/`one<T>` are generic over the CALLER's row type, so no
  // fake can name it — and `unknown` is what a driver really has, bytes off the wire that nothing
  // has validated. One assertion, at that boundary, instead of one per method body.
  const opaque: unknown = row;
  const rows: readonly unknown[] = [row];
  return {
    query: <T>(): Promise<readonly T[]> => Promise.resolve(rows as readonly T[]),
    one: <T>(): Promise<T> => Promise.resolve(opaque as T),
    execute: () => Promise.resolve(1),
  };
};

/** The row as the repository sees it: every cell's driver value. */
const throughRepository = async (
  cells: Readonly<Record<string, Cell>>,
): Promise<Readonly<Record<string, unknown>>> => {
  const physical = Object.fromEntries(
    Object.entries(cells).map(([column, cell]) => [column, cell.driver]),
  );
  const repo = postgresRepo(products, { client: clientOver(physical) });
  const row = await repo.findById(PRODUCT_ID);
  expect(row).not.toBeNull();
  return row as Readonly<Record<string, unknown>>;
};

/** The row as the replicator sees it: every cell's WAL text, through its own type oid. */
const throughWal = (cells: Readonly<Record<string, Cell>>): Readonly<Record<string, unknown>> => {
  const physical: Record<string, PhysicalValue> = {};
  for (const [column, cell] of Object.entries(cells)) {
    physical[column] = cell.wal === null ? null : decodeValue(cell.oid, cell.wal);
  }
  return entityRow(physical);
};

const priceOf = (row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  row['price'] as Readonly<Record<string, unknown>>;

/** Every column of the entity above, in declaration order. */
const wholeRow = (): Record<string, Cell> => ({
  id: { oid: OID.uuid, wal: PRODUCT_ID, driver: PRODUCT_ID },
  title: { oid: OID.text, wal: 'widget', driver: 'widget' },
  tags: { oid: OID.textArray, wal: '{a,b}', driver: ['a', 'b'] },
  thumbnail: { oid: OID.bytea, wal: '\\x0102', driver: Buffer.from([1, 2]) },
  published_at: {
    oid: OID.timestamptz,
    wal: '2026-08-09 12:00:00+00',
    driver: new Date('2026-08-09T12:00:00.000Z'),
  },
  price_minor: { oid: OID.int8, wal: '2', driver: '2' },
  price_currency: { oid: OID.bpchar, wal: 'USD', driver: 'USD' },
  price_scale: { oid: OID.int4, wal: '6', driver: 6 },
});

test('an array column is an array on both surfaces, never the postgres literal', async () => {
  const cells = wholeRow();
  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  expect(live['tags']).toEqual(['a', 'b']);
  expect(stored['tags']).toEqual(['a', 'b']);
  expect(live['tags']).toStrictEqual(stored['tags']);
});

test('a timestamp column is one instant on both surfaces, never postgres text', async () => {
  const cells = wholeRow();
  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  // `toStrictEqual` on purpose: the failure that shipped was a `Date` on one side and a string on
  // the other, and `toEqual` between those two is already false — but the ISO string this decoder
  // could have produced instead would compare EQUAL to nothing and sort against a `Date`'s epoch
  // number, which is symptom A. The type is the claim.
  expect(live['publishedAt']).toBeInstanceOf(Date);
  expect(stored['publishedAt']).toBeInstanceOf(Date);
  expect(live['publishedAt']).toStrictEqual(stored['publishedAt']);
});

test('a bytea column is bytes on both surfaces', async () => {
  const cells = wholeRow();
  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  expect(live['thumbnail']).toBeInstanceOf(Uint8Array);
  expect(stored['thumbnail']).toBeInstanceOf(Uint8Array);
  expect(live['thumbnail']).toStrictEqual(stored['thumbnail']);
});

test('the whole row is one object, column for column', async () => {
  const cells = wholeRow();
  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  expect(live).toStrictEqual(stored);
  expect(Object.keys(live)).toEqual(Object.keys(stored));
  // What both sides must be, absolutely, so the two cannot fail open together and still agree.
  expect(live).toStrictEqual({
    id: PRODUCT_ID,
    title: 'widget',
    tags: ['a', 'b'],
    thumbnail: new Uint8Array([1, 2]),
    publishedAt: new Date('2026-08-09T12:00:00.000Z'),
    price: { minor: 2, currency: 'USD', scale: 6 },
  });
});

test('an unscaled amount carries no scale key on either surface', async () => {
  // NULL is what every row written before the column existed holds, and `0` is a different value:
  // it means whole units, a 100x reinterpretation of an ordinary price.
  const cells = wholeRow();
  cells['price_minor'] = { oid: OID.int8, wal: '1990', driver: '1990' };
  cells['price_scale'] = { oid: OID.int4, wal: null, driver: null };

  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  expect(priceOf(live)).toStrictEqual({ minor: 1990, currency: 'USD' });
  expect(Object.hasOwn(priceOf(live), 'scale')).toBe(false);
  expect(Object.hasOwn(priceOf(stored), 'scale')).toBe(false);
  expect(live).toStrictEqual(stored);
});

test('a projection that left the scale column out reads as no scale, not as zero', async () => {
  const cells = wholeRow();
  cells['price_minor'] = { oid: OID.int8, wal: '1990', driver: '1990' };
  delete cells['price_scale'];

  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  expect(priceOf(live)).toStrictEqual({ minor: 1990, currency: 'USD' });
  expect(Object.hasOwn(priceOf(stored), 'scale')).toBe(false);
  expect(live).toStrictEqual(stored);
});

test('the scale column never survives as a property of its own', async () => {
  const cells = wholeRow();
  const live = throughWal(cells);
  const stored = await throughRepository(cells);

  const properties = ['id', 'title', 'tags', 'thumbnail', 'publishedAt', 'price'];
  expect(Object.keys(live)).toEqual(properties);
  expect(Object.keys(stored)).toEqual(properties);
});
