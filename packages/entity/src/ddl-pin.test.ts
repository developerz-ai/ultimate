// Single responsibility: the DDL this package's declarations become, pinned BYTE FOR BYTE for the
// column kinds and invariant forms whose app-side rule was changed without touching what they
// emit. Every app holds migrations and a schema hash taken over this text, so a change here is a
// migration every app must generate — a decision, and this file is where it becomes visible.

import { afterAll, expect, test } from 'bun:test';
import { generateMigration } from '@ultimat3/db';
import { integer, text, url, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { entity } from './entity';
import { iff } from './expr';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const ledgers = entity('ddl_pin_ledgers', {
  columns: {
    id: uuid().primaryKey(),
    slug: text({ max: 40 }),
    title: text({ max: 80 }),
    href: url().nullable(),
    total: bigint(),
    rate: decimal({ precision: 8, scale: 2 }),
    share: decimal({ precision: 2, scale: 2 }).nullable(),
    loose: decimal().nullable(),
    count: integer().default(0),
  },
  invariants: (c) => [
    invariant('title_present', c.title.trimmed().minLength(1)),
    invariant('total_non_negative', c.total.atLeast(0)),
    invariant('rate_fixed', c.rate.eq(1.5)),
    invariant('count_matches', c.count.eq(c.total)),
    invariant('slug_shape', c.slug.matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
    invariant('href_coherent', iff(c.href.isNotNull(), c.share.isNotNull())),
    invariant('slug_unique', c.unique(['slug'])),
  ],
});

const EXPECTED = `create table "ddl_pin_ledgers" (
  "id" uuid default gen_random_uuid() not null,
  "slug" text not null,
  "title" text not null,
  "href" text,
  "total" bigint not null,
  "rate" numeric(8, 2) not null,
  "share" numeric(2, 2),
  "loose" numeric,
  "count" integer default 0 not null,
  primary key ("id"),
  constraint "ddl_pin_ledgers_slug_check" check (char_length(slug) <= 40),
  constraint "ddl_pin_ledgers_title_check" check (char_length(title) <= 80),
  constraint "ddl_pin_ledgers_href_check" check (href ~ '^https?://'),
  constraint "ddl_pin_ledgers_title_present_check" check (char_length(btrim(title)) >= 1),
  constraint "ddl_pin_ledgers_total_non_negative_check" check (total >= 0),
  constraint "ddl_pin_ledgers_rate_fixed_check" check (rate = 1.5),
  constraint "ddl_pin_ledgers_count_matches_check" check (count = total),
  constraint "ddl_pin_ledgers_slug_shape_check" check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint "ddl_pin_ledgers_href_coherent_check" check ((href is not null) = (share is not null))
);
create unique index "ddl_pin_ledgers_slug_unique_key" on "ddl_pin_ledgers" ("slug");`;

test('the emitted DDL is exactly this text', () => {
  const migration = generateMigration({
    entities: [ledgers.$describe()],
    name: 'ddl pin',
    now: new Date('2026-10-02T00:00:00.000Z'),
  });
  expect(migration.up).toBe(EXPECTED);
});
