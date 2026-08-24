// Single responsibility: an index's access method — the closed set an entity may declare, the one
// normalisation both sides of a comparison pass through, and the DDL fragment. Its own file for the
// reason `foreign-key.ts` holds `onDeleteRule`: a generator and a detector that disagreed about
// what "the default" is would report drift on a database that is exactly right.

import { indexMethodInvalid } from './errors';

/**
 * The methods an entity may declare. Two members, deliberately: `btree` is what every index has
 * always been, and `gin` is the one with a caller — `@>` / `<@` / `&&` / `?` on a `json()` or
 * `arrayOf()` column is a sequential scan without it.
 *
 * `gist`, `brin`, `hash` and `spgist` are legitimate Postgres methods and are **not** here, because
 * nothing declares one and each brings a rule of its own that would have to be enforced with no
 * caller to test it — `hash` and `brin` cannot be unique, `gist` needs `btree_gist` to be, and none
 * of the three accepts `asc`/`desc`. Adding a member later is additive; shipping four that nobody
 * uses is four ways for a first caller to be silently wrong. A method the catalog reports and this
 * set does not carry is still READ and still compared — see `indexMethodOf`.
 */
export const INDEX_METHODS = ['btree', 'gin'] as const;

export type IndexMethod = (typeof INDEX_METHODS)[number];

export function isIndexMethod(value: unknown): value is IndexMethod {
  return typeof value === 'string' && (INDEX_METHODS as readonly string[]).includes(value);
}

/**
 * What method this index is on, whichever side it came from. `undefined` is `btree` — Postgres'
 * own default, which nothing writes out, which every index created before this existed is, and
 * which is therefore what a snapshot recorded before it carried the field at all.
 *
 * The CATALOG's answer is passed through verbatim, `gist` and an extension's own access method
 * included: the live side is whatever `pg_am` said, and folding an unknown name into `btree` would
 * hide exactly the difference an operator needs to see.
 */
export function indexMethodOf(index: { readonly using?: string | undefined }): string {
  return index.using ?? 'btree';
}

/**
 * The closed-set reading of a method that arrived on the OPEN side — a catalog row or a snapshot
 * this generator did not write. `undefined` for absent, and a **refusal** for anything the set does
 * not carry, never a silent fall back to `btree`: the one caller is `redefineIndex`, whose `down`
 * recreates the index a previous migration recorded, and a `gist` quietly rebuilt as a btree is a
 * rollback that leaves the database in a state no migration describes.
 */
export function declaredMethod(using: string | undefined): IndexMethod | undefined {
  if (using === undefined) return undefined;
  if (!isIndexMethod(using)) throw indexMethodInvalid(using);
  return using;
}

/**
 * The clause, or `''` for a btree — so an index that declared nothing emits the statement it always
 * did, byte for byte.
 *
 * The literal is **re-derived from the set, never spliced from the input**, the same shape
 * `isolationMode` uses for `BEGIN`. The type is not the guard: this value reaches `create index …`
 * as text from an entity declaration, a config or a generator, and `using ${method}` on an operand
 * TypeScript never saw is the identical hole to the one `columnName` carried — a name that closed
 * the parenthesis and opened a second command.
 */
export function indexMethodSql(method: IndexMethod): string {
  switch (method) {
    case 'btree':
      return '';
    case 'gin':
      return ' using gin';
    default: {
      const unhandled: never = method;
      throw indexMethodInvalid(unhandled);
    }
  }
}
