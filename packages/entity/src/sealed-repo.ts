// Single responsibility: the ONE seam a sealed column crosses. A repository wrapped here seals the
// sealed properties of every row and patch on the way in, opens them on the way out, and rewrites
// or refuses every predicate that names one — so both drivers store ciphertext and neither knows
// it. Both driver factories return through this, which is why the typed handle and a hand-held
// `postgresRepo()` cannot disagree. An entity with no sealed column gets its repository back as is.

import { pageOf } from '@ultimat3/core';
import type { AggregateFn } from './aggregate';
import { namedColumns } from './plan';
import type { FindManyArgs, Repo, UpsertArgs } from './repo';
import type { SealedField, SealedSource, SealKeys } from './sealed';
import {
  lookupCandidates,
  openValue,
  sealedFields,
  sealKeysOnce,
  sealValue,
  serverOnly,
} from './sealed';
import type { SealedUse } from './sealed-errors';
import { sealedLookupValue, sealedMissing, sealedPredicate } from './sealed-errors';
import type { Predicate } from './tenancy';

type Loose = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null;

/**
 * A row or a patch with its sealed properties sealed. Only a STRING is sealed: `null` clears the
 * column, `undefined` leaves it alone, and anything else is not a value this column holds — it is
 * passed on untouched so the driver's own `$parse` refuses it in the words it always uses.
 *
 * Each sealed property is read BY NAME and carried explicitly, because the copy below is a spread
 * and a repository row does not enumerate one: `insert(row)` and `update(id, row)` with a row
 * passed back whole write exactly what the row holds, a `null` included.
 *
 * `inserting` says the values are a whole ROW: a required sealed column it lacks is refused here,
 * in words that name the spread that usually lost it. The typed handle refuses the same row with
 * the same error one step earlier (`entity.$parse`); this is the hand-held repository's.
 */
const sealRow = async <T>(
  entity: SealedSource,
  fields: readonly SealedField[],
  values: T,
  keys: SealKeys,
  inserting = false,
): Promise<T> => {
  if (!isRecord(values)) return values;
  const sealed: Record<string, unknown> = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.property) ? values[field.property] : undefined;
    if (typeof value === 'string') sealed[field.property] = await sealValue(field, value, keys);
    else if (value !== undefined) sealed[field.property] = value;
    else if (inserting && field.required) throw sealedMissing(entity.$name, field.property);
  }
  // A copy, never the caller's object: the row they hold keeps the plaintext they wrote.
  return { ...values, ...sealed } as T;
};

/**
 * A stored row with its sealed properties opened. A projection that left one out leaves it out.
 * Opened means SERVER-ONLY (`serverOnly`): the plaintext is read by name and enumerated by nothing,
 * so the row a repository answers can be serialised whole and the secret stays here.
 */
const openRow = async <T>(fields: readonly SealedField[], row: T, keys: SealKeys): Promise<T> => {
  if (!isRecord(row)) return row;
  const opened: Record<string, unknown> = {};
  for (const field of fields) {
    const value = Object.hasOwn(row, field.property) ? row[field.property] : undefined;
    if (typeof value === 'string') opened[field.property] = await openValue(field, value, keys);
  }
  return serverOnly(fields, row, opened) as T;
};

const openRows = <T>(
  fields: readonly SealedField[],
  rows: readonly T[],
  keys: SealKeys,
): Promise<T[]> => Promise.all(rows.map((row) => openRow(fields, row, keys)));

/**
 * One predicate, as the database can answer it.
 *
 * A NULL test passes through for EVERY sealed column: `null` is never sealed — it is stored as
 * NULL in a nullable `text` column — so whether a value is present is a fact the schema already
 * publishes, and it is what lets a backfill visit only the rows still to be sealed. Past that an
 * opaque column answers nothing, and a lookup column answers equality: `eq` and `in` are rewritten
 * to the stored strings the value seals to — one per declared key, so a rotation in progress still
 * finds the rows written before it.
 */
const rewrite = async (
  entity: SealedSource,
  fields: readonly SealedField[],
  predicate: Predicate,
  keys: SealKeys,
): Promise<Predicate> => {
  const field = fields.find((one) => one.property === predicate.column);
  if (field === undefined) return predicate;
  const { op, value } = predicate;
  if (op === 'is-null' || op === 'is-not-null') return predicate;
  if (!field.lookup) throw sealedPredicate(entity.$name, field.property, 'a filter', false);
  // A stored value is ciphertext or NULL, so anything but a string or a NULL would reach the driver
  // and match nothing — indistinguishable from "no such row". Refused instead.
  const sealable = (one: unknown): boolean =>
    typeof one === 'string' || one === null || one === undefined;
  if ((op === 'eq' || op === 'in') && !(Array.isArray(value) ? value : [value]).every(sealable)) {
    throw sealedLookupValue(entity.$name, field.property, op === 'in' ? 'list' : 'value');
  }
  if (op === 'eq') {
    if (typeof value !== 'string') return predicate;
    const candidates = await lookupCandidates(field, value, keys);
    const [only] = candidates;
    return candidates.length === 1 && only !== undefined
      ? { ...predicate, value: only }
      : { ...predicate, op: 'in', value: candidates };
  }
  if (op === 'in' && Array.isArray(value)) {
    const lists = await Promise.all(
      value.map((one: unknown) =>
        typeof one === 'string' ? lookupCandidates(field, one, keys) : [one],
      ),
    );
    return { ...predicate, value: lists.flat() };
  }
  throw sealedPredicate(entity.$name, field.property, 'a filter', true);
};

/** A column named where no rewrite exists: an order, a group, an aggregate, a write's filter. */
const refuseNamed = (
  entity: SealedSource,
  fields: readonly SealedField[],
  properties: readonly string[],
  use: SealedUse,
  lookupAllowed = false,
): void => {
  for (const property of properties) {
    const field = fields.find((one) => one.property === property);
    if (field === undefined || (lookupAllowed && field.lookup)) continue;
    throw sealedPredicate(entity.$name, field.property, use, field.lookup);
  }
};

const readArgs = async <A extends FindManyArgs>(
  entity: SealedSource,
  fields: readonly SealedField[],
  args: A | undefined,
  keys: SealKeys,
): Promise<A | undefined> => {
  if (args === undefined) return args;
  refuseNamed(
    entity,
    fields,
    (args.orderBy ?? []).map((key) => key.column),
    'an order',
  );
  if (args.where === undefined) return args;
  const where = await Promise.all(args.where.map((one) => rewrite(entity, fields, one, keys)));
  return { ...args, where };
};

/**
 * `repo`, sealing. Every method stays `async` and rejects rather than throws, as the contract
 * requires. Written as a spread over the inner repository so a member this file does not know —
 * `MemoryRepo.reset()` — survives it.
 */
export const sealedRepo = <Row, R extends Repo<Row>>(entity: SealedSource, repo: R): R => {
  const fields = sealedFields(entity);
  if (fields.length === 0) return repo;
  const filterOf = (filter: unknown): readonly string[] =>
    namedColumns(filter).map(([property]) => property);

  // Every method takes its own ring: one resolution per repository call, however many values.
  const sealing: Repo<Row> = {
    async findById(id, options) {
      const row = await repo.findById(id, options);
      return row === null ? null : openRow(fields, row, sealKeysOnce());
    },
    async findMany(args) {
      const keys = sealKeysOnce();
      const page = await repo.findMany(await readArgs(entity, fields, args, keys));
      return pageOf(await openRows(fields, page.rows, keys), page.nextCursor);
    },
    async insert(values, options) {
      const keys = sealKeysOnce();
      const stored = await repo.insert(await sealRow(entity, fields, values, keys, true), options);
      return openRow(fields, stored, keys);
    },
    async insertAll(rows, options) {
      const keys = sealKeysOnce();
      const sealed = await Promise.all(rows.map((row) => sealRow(entity, fields, row, keys, true)));
      return openRows(fields, await repo.insertAll(sealed, options), keys);
    },
    async upsertAll(rows, args: UpsertArgs<Row>) {
      // A conflict target is a uniqueness comparison, so it is a lookup column's or nobody's.
      refuseNamed(entity, fields, args.onConflict, 'an upsert conflict target', true);
      const keys = sealKeysOnce();
      const sealed = await Promise.all(rows.map((row) => sealRow(entity, fields, row, keys, true)));
      return openRows(fields, await repo.upsertAll(sealed, args), keys);
    },
    async update(id, patch, options) {
      const keys = sealKeysOnce();
      const stored = await repo.update(id, await sealRow(entity, fields, patch, keys), options);
      return openRow(fields, stored, keys);
    },
    delete: (id, options) => repo.delete(id, options),
    // A filtered write's filter is refused for every sealed column, lookup included: its shape is
    // one value per column, and during a rotation a lookup value has one stored form PER KEY.
    async deleteWhere(filter, options) {
      refuseNamed(entity, fields, filterOf(filter), "a filtered write's filter");
      return repo.deleteWhere(filter, options);
    },
    async updateWhere(filter, patch, options) {
      refuseNamed(entity, fields, filterOf(filter), "a filtered write's filter");
      return repo.updateWhere(
        filter,
        await sealRow(entity, fields, patch, sealKeysOnce()),
        options,
      );
    },
    async count(args) {
      return repo.count(await readArgs(entity, fields, args, sealKeysOnce()));
    },
    async countBy(column, args) {
      refuseNamed(entity, fields, [column], 'a grouped count');
      return repo.countBy(column, await readArgs(entity, fields, args, sealKeysOnce()));
    },
    async aggregate(fn: AggregateFn, column, args) {
      refuseNamed(entity, fields, [column], 'an aggregate');
      return repo.aggregate(fn, column, await readArgs(entity, fields, args, sealKeysOnce()));
    },
    async approximateCount(args) {
      return repo.approximateCount(await readArgs(entity, fields, args, sealKeysOnce()));
    },
  };
  return { ...repo, ...sealing };
};
