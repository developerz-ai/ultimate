// What an index is CALLED. Split out of `entity.ts` at the 500-line ceiling, and it is one job:
// two indexes that differ only in their predicate, their direction or their access method must not
// share a name, and no name may cross the 63 bytes Postgres silently truncates at.

import type { IndexMethod } from '@ultimat3/db';
import { invariantViolated } from './errors';

/**
 * What separates two indexes on the SAME columns: the predicate, the direction and the ACCESS
 * METHOD. Eight hex characters of sha256 over all three — deterministic across processes, so a
 * name is a property of the declaration and never of the run that generated it.
 *
 * The method belongs here for exactly the reason `where` does. A btree on an `arrayOf()` column
 * answers `=` and an ordering; a GIN on the same column answers `@>` / `<@` / `&&`. They are two
 * distinct indexes, and without the method in the name both are `<table>_<cols>_idx` — where the
 * dedup below drops one in silence (the defect this discriminator was added for) or, since that
 * dedup is now on the whole definition, two `create index` statements share one name and the
 * migration is `42P07`.
 */
const indexDiscriminator = (
  order: string | undefined,
  where: string | null,
  using: string | undefined,
): string =>
  new Bun.CryptoHasher('sha256')
    // The method is APPENDED only when one was declared, never as an empty field: every name this
    // function has ever minted for a partial or ordered index is therefore unchanged by the method
    // existing, and an index that declares no method is byte-identical to the one it was.
    .update(`${order ?? ''}|${where ?? ''}${using === undefined ? '' : `|${using}`}`)
    .digest('hex')
    .slice(0, 8);

/**
 * `<table>_<columns>_idx`, plus a discriminator when — and only when — the index carries a
 * predicate, a direction or a non-default access method.
 *
 * Only then, because the plain name is load-bearing in two places: `unique()` on a column is an
 * inline column clause and Postgres names the index it creates exactly `<table>_<column>_key`, so
 * a discriminator there would make the generator emit a second `create unique index` for an index
 * that already exists (`42P07`); and a foreign key's own index is deduped against a hand-declared
 * one by this name.
 *
 * Without it, two DIFFERENT partial indexes on one column were one name — `posts_author_id_idx`
 * for both `where status = 'published'` and `where status = 'draft'` — and the dedup below dropped
 * the second with no error, no warning and no drift finding, since a declared index is matched by
 * name.
 */
/**
 * `NAMEDATALEN - 1`. Postgres truncates a longer identifier and says NOTHING, so two index names
 * sharing their first 63 bytes become one index on the server — the same silent collapse the
 * discriminator above exists to prevent, one layer down, and invisible to a drift check comparing
 * DECLARED names because those still differ. Bytes and not characters: 63 is what the server
 * counts, and `.length` would stop seeing the truncation the moment a name is not ASCII.
 */
const MAX_IDENTIFIER_BYTES = 63;

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export const indexName = (
  entityName: string,
  table: string,
  columns: readonly string[],
  unique: boolean,
  order?: string | undefined,
  where: string | null = null,
  using?: IndexMethod | undefined,
): string => {
  const suffix = unique ? 'key' : 'idx';
  const base = `${table}_${columns.join('_')}`;
  const plain = order === undefined && where === null && using === undefined;
  const name = plain
    ? `${base}_${suffix}`
    : `${base}_${indexDiscriminator(order, where, using)}_${suffix}`;
  const bytes = byteLength(name);
  if (bytes <= MAX_IDENTIFIER_BYTES) return name;
  throw invariantViolated(
    entityName,
    'index',
    `the index on (${columns.join(', ')}) is named "${name}", which is ${bytes} bytes — ` +
      `Postgres truncates an identifier at ${MAX_IDENTIFIER_BYTES} and does not say so, ` +
      'so two indexes can silently become one',
  );
};
