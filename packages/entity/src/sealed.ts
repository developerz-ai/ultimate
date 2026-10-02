// Single responsibility: which columns of an entity are sealed, and the two conversions a value
// crosses on — plaintext to the stored string on a write, the stored string back on a read. The
// cipher is `@ultimat3/core`'s `seal()` / `open()`; this file only decides WHAT is sealed, under
// which purpose. `sealed-repo.ts` is the one caller on the row path.

import type { SealKeyRing } from '@ultimat3/core';
import { openText, resolveSealKeys, seal, sealAll } from '@ultimat3/core';
import { columnName } from './column';
import type { AnyColumn, ColumnMap } from './types';

/** The slice of an entity this reads, so the declaration path can ask before `entity()` returns. */
export interface SealedSource {
  readonly $name: string;
  readonly $table: string;
  readonly $columns: ColumnMap;
}

export interface SealedField {
  /** Property key on the row. */
  readonly property: string;
  /** Physical column — half of the purpose, and what `x doctor` names. */
  readonly column: string;
  /**
   * `entity:<table>.<column>`, derived and never stated: two columns cannot share one by accident,
   * so a value copied from one sealed column into another does not open there. PHYSICAL names —
   * the ones a migration renames — so renaming the table or the column is a re-seal.
   */
  readonly purpose: string;
  readonly lookup: boolean;
  /** NOT NULL — and a sealed column takes no default, so a row to insert must carry it. */
  readonly required: boolean;
  /**
   * The column's own parser, which judges a PLAINTEXT — `text({ max })` included. Run before a
   * value is sealed, because nothing after that point can: the driver only ever sees the sealed
   * string, which is longer than any bound the author wrote.
   */
  readonly parse: (value: unknown) => unknown;
}

export const sealedPurpose = (table: string, column: string): string => `entity:${table}.${column}`;

const describeField = (table: string, property: string, column: AnyColumn): SealedField[] => {
  const sealed = column.$meta.sealed;
  if (sealed === undefined) return [];
  const physical = columnName(property, column.$meta);
  return [
    {
      property,
      column: physical,
      purpose: sealedPurpose(table, physical),
      lookup: sealed.lookup,
      required: column.$meta.notNull,
      parse: column.$parse,
    },
  ];
};

const fields = new WeakMap<ColumnMap, readonly SealedField[]>();

/**
 * Every sealed column of the entity, in declaration order — empty for almost every entity, and
 * that is the fast path: a repository over one with none is returned untouched. Memoised on the
 * column map, which is the declaration itself and outlives nothing it should not.
 */
export const sealedFields = (entity: SealedSource): readonly SealedField[] => {
  const known = fields.get(entity.$columns);
  if (known !== undefined) return known;
  const found = Object.entries(entity.$columns).flatMap(([property, column]) =>
    describeField(entity.$table, property, column),
  );
  fields.set(entity.$columns, found);
  return found;
};

/**
 * The key ring for ONE repository call, resolved the first time a value needs it and shared by
 * every value after. A 500-row page with two sealed columns is a thousand values and one ring —
 * not a thousand reads of the environment or the key file. Lazy, so a call that seals and opens
 * nothing needs no key at all; per call and never longer, so a rotation is seen by the next one.
 */
export type SealKeys = () => Promise<SealKeyRing>;

export const sealKeysOnce = (): SealKeys => {
  let ring: Promise<SealKeyRing> | undefined;
  return () => {
    ring ??= resolveSealKeys();
    return ring;
  };
};

/**
 * The stored form of one value: validated as the plaintext it is, then sealed. A lookup column
 * seals deterministically so equality survives. `async`, so a refused value rejects like every
 * other repository failure rather than throwing at the call.
 */
export const sealValue = async (
  field: SealedField,
  plaintext: string,
  keys: SealKeys,
): Promise<string> => {
  const checked = field.parse(plaintext);
  return seal(typeof checked === 'string' ? checked : plaintext, {
    purpose: field.purpose,
    deterministic: field.lookup,
    keys: await keys(),
  });
};

/**
 * The plaintext of one stored value. A stored string that is not a sealed value is
 * `X_SEAL_INVALID`, always: there is no reading of an unsealed row, so a column sealed after rows
 * were written is migrated by expand, `backfill()`, contract — never by tolerating the old rows.
 */
export const openValue = async (
  field: SealedField,
  stored: string,
  keys: SealKeys,
): Promise<string> => openText(stored, { purpose: field.purpose, keys: await keys() });

/**
 * Every stored string a lookup may match `plaintext` against: one per declared key. Outside a
 * rotation that is one string; while a retired key is still declared it is two, so the rows
 * written before the rotation are still found.
 */
export const lookupCandidates = async (
  field: SealedField,
  plaintext: string,
  keys: SealKeys,
): Promise<readonly string[]> => sealAll(plaintext, { purpose: field.purpose, keys: await keys() });

type Loose = Readonly<Record<string, unknown>>;

/**
 * A copy of `row` whose sealed properties are SERVER-ONLY: own, readable and writable —
 * `row.password` is the plaintext and the row type does not change — but NOT ENUMERABLE. So
 * `JSON.stringify`, an object spread, `Object.keys`/`entries`, `structuredClone` and every
 * serialiser built on them leave the property behind, which is what keeps a row handed whole to a
 * `query`, an island prop, a log line, a job payload or a cache tier from carrying the secret out.
 * Fail closed: a path nobody listed omits it too, and an explicit `row.password` is the only read.
 *
 * `opened` wins over the stored value; a property the row does not have is not invented, and a
 * NULL is hidden like a value — whether a secret is set is not for the wire either.
 */
export const serverOnly = <T extends Loose>(
  fields: readonly SealedField[],
  row: T,
  opened: Loose = {},
): T => {
  const out: Record<string, unknown> = { ...row };
  for (const { property } of fields) {
    if (!Object.hasOwn(row, property)) continue;
    Object.defineProperty(out, property, {
      value: Object.hasOwn(opened, property) ? opened[property] : row[property],
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
};

/**
 * A copy of a row that KEEPS what `serverOnly` set — `{ ...row }` would drop every sealed property,
 * which is the point of it everywhere a row leaves and wrong where server code only wants its own
 * object. Enumerable properties stay enumerable, so this is a spread for every other entity.
 */
export const copyRow = <T extends object>(row: T): T =>
  Object.defineProperties({}, Object.getOwnPropertyDescriptors(row)) as T;

/**
 * `keys` of a row, each as the row holds it: a projection that NAMES a sealed column still answers
 * it server-only. Assigning the value instead would re-create it enumerable, and a row that names
 * the secret would be the one repository row that serialises it. A key the row lacks is present
 * and `undefined`, as an assignment would leave it.
 */
export const pickRow = <T extends object, K extends keyof T & string>(
  row: T,
  keys: readonly K[],
): Pick<T, K> => {
  const picked = {};
  for (const key of keys) {
    Object.defineProperty(
      picked,
      key,
      Object.getOwnPropertyDescriptor(row, key) ?? {
        value: undefined,
        enumerable: true,
        writable: true,
        configurable: true,
      },
    );
  }
  return picked as Pick<T, K>;
};
