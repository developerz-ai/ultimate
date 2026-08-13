// The one claim neither sibling makes: `preload.test.ts` proves what attaches against memory,
// `preload-statements.test.ts` proves the statement shape against a recording client standing in
// for Postgres — but nothing seeds the same logical rows into both and asserts the attached values
// agree. This file does exactly that: same ids, same foreign keys, one chain run against each
// driver, `toEqual` across the pair.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const orgs = entity('preload_parity_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }) },
});

const members = entity('preload_parity_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 120 }),
  },
});

const posts = entity('preload_parity_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    authorId: uuid().references(() => members.id),
    /** Nullable, and pointed at an id no member holds on `P3` — the two shapes `belongsTo` has to
     * attach `null` for, and both have to read the same across drivers. */
    reviewerId: uuid()
      .references(() => members.id)
      .nullable(),
    title: text({ max: 120 }),
  },
});

const entities = { orgs, members, posts };
type Db = ReturnType<typeof database<typeof entities>>;

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

/**
 * A `hasMany` is named for the entity the rows come from, and both inbound keys want that name —
 * so every member of the group takes its long form, exactly as `preload.test.ts` spells it.
 */
const BY_AUTHOR = 'preload_parity_postsByAuthor';
const BY_REVIEWER = 'preload_parity_postsByReviewer';

const ORG = idAt(1);
const ANA = idAt(10);
const BEN = idAt(11);
/** Referenced by a foreign key, never inserted anywhere — the "resolved to nothing" case. */
const GHOST = idAt(99);
const P1 = idAt(20);
const P2 = idAt(21);
const P3 = idAt(22);

/** What Bun.SQL hands back: snake_case names, nothing decoded — same convention as
 * `preload-statements.test.ts`'s `postRow`/`memberRow`. */
const postRow = (id: string, authorId: string, reviewerId: string | null, title: string) => ({
  id,
  org_id: ORG,
  author_id: authorId,
  reviewer_id: reviewerId,
  title,
});

const memberRow = (id: string) => ({ id, org_id: ORG, email: `${id}@example.com` });

const field = (row: unknown, key: string): unknown => (row as Record<string, unknown>)[key];

let mem: Db;
let client: RecordingClient;

/** The identical logical rows on both sides: same ids, same foreign keys, same tenant. */
beforeEach(async () => {
  mem = database(entities, { driver: memoryDriver() });
  await mem.orgs.insert({ id: ORG, slug: 'ours' });
  await mem.members.insert({ id: ANA, orgId: ORG, email: `${ANA}@example.com` });
  await mem.members.insert({ id: BEN, orgId: ORG, email: `${BEN}@example.com` });
  await mem.posts.insert({ id: P1, orgId: ORG, authorId: ANA, title: 'First' });
  await mem.posts.insert({ id: P2, orgId: ORG, authorId: ANA, reviewerId: BEN, title: 'Second' });
  await mem.posts.insert({ id: P3, orgId: ORG, authorId: BEN, reviewerId: GHOST, title: 'Third' });

  client = createRecordingClient();
  setDbClient(client);
  client.on('preload_parity_posts', {
    rows: [
      postRow(P1, ANA, null, 'First'),
      postRow(P2, ANA, BEN, 'Second'),
      postRow(P3, BEN, GHOST, 'Third'),
    ],
  });
  client.on('preload_parity_members', { rows: [memberRow(ANA), memberRow(BEN)] });
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const pg = (): Db => database(entities, { driver: postgresDriver() });

describe('memory and postgres attach the same values', () => {
  test('a belongsTo attaches the identical row, and a resolved-to-nothing key attaches the identical null', async () => {
    const memRows = await mem.posts
      .where({ orgId: ORG })
      .orderBy('id')
      .preload('author')
      .preload('reviewer')
      .all();
    const pgRows = await pg()
      .posts.where({ orgId: ORG })
      .orderBy('id')
      .preload('author')
      .preload('reviewer')
      .all();

    expect(pgRows).toEqual(memRows);
    // Pinned independently of the parity claim, so a bug shared by both drivers cannot hide here.
    expect(field(memRows[0], 'author')).toMatchObject({ id: ANA });
    expect(field(memRows[0], 'reviewer')).toBeNull();
    expect(field(memRows[1], 'reviewer')).toMatchObject({ id: BEN });
    // GHOST is a key that resolved to nothing — null, on both drivers, never an absent property.
    expect(field(memRows[2], 'reviewer')).toBeNull();
    expect('reviewer' in (memRows[2] as object)).toBe(true);
    expect('reviewer' in (pgRows[2] as object)).toBe(true);
  });

  test('a hasMany attaches the identical array, same order, empty the same way', async () => {
    const memRows = await mem.members
      .where({ orgId: ORG })
      .orderBy('id')
      .preload(BY_AUTHOR)
      .preload(BY_REVIEWER)
      .all();
    const pgRows = await pg()
      .members.where({ orgId: ORG })
      .orderBy('id')
      .preload(BY_AUTHOR)
      .preload(BY_REVIEWER)
      .all();

    expect(pgRows).toEqual(memRows);
    // ANA authored P1 and P2, in that order; BEN reviewed neither post ANA authored — []          .
    expect(
      (field(memRows[0], BY_AUTHOR) as readonly unknown[]).map((row) => field(row, 'id')),
    ).toEqual([P1, P2]);
    expect(field(memRows[0], BY_REVIEWER)).toEqual([]);
    // BEN authored P3 and reviewed P2 — one of each, never merged into one array.
    expect(
      (field(memRows[1], BY_AUTHOR) as readonly unknown[]).map((row) => field(row, 'id')),
    ).toEqual([P3]);
    expect(
      (field(memRows[1], BY_REVIEWER) as readonly unknown[]).map((row) => field(row, 'id')),
    ).toEqual([P2]);
  });

  test('a belongsTo and a hasMany never trade shapes — object or null one side, array the other', async () => {
    const [post] = await mem.posts.where({ orgId: ORG, id: P1 }).preload('author').all();
    const [member] = await mem.members.where({ orgId: ORG, id: ANA }).preload(BY_AUTHOR).all();

    expect(Array.isArray(field(post, 'author'))).toBe(false);
    expect(Array.isArray(field(member, BY_AUTHOR))).toBe(true);

    const [pgPost] = await pg().posts.where({ orgId: ORG, id: P1 }).preload('author').all();
    const [pgMember] = await pg().members.where({ orgId: ORG, id: ANA }).preload(BY_AUTHOR).all();

    expect(Array.isArray(field(pgPost, 'author'))).toBe(false);
    expect(Array.isArray(field(pgMember, BY_AUTHOR))).toBe(true);
  });

  test('attachment survives composition with select() — the same narrowed row on both drivers', async () => {
    const memRows = await mem.posts
      .where({ orgId: ORG })
      .orderBy('id')
      .select({ id: true, title: true })
      .preload('author')
      .all();
    const pgRows = await pg()
      .posts.where({ orgId: ORG })
      .orderBy('id')
      .select({ id: true, title: true })
      .preload('author')
      .all();

    expect(pgRows).toEqual(memRows);
    // The projection really did narrow the row: only what was selected plus what was preloaded.
    expect(Object.keys(memRows[0] as object).sort()).toEqual(['author', 'id', 'title']);
    expect(field(memRows[0], 'author')).toMatchObject({ id: ANA });
  });
});
