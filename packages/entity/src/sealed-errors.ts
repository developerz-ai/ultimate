// The two refusals a sealed column raises: named where the database would have to read it, and
// named in a view. Split from `errors.ts` for `feature-errors.ts`'s reason — the codes and titles
// stay in `entity-error.ts`. Imports `entity-error.ts`, never `errors.ts`: `entity()` raises these
// while it is being declared, and that path is one a browser bundle evaluates.

import { EntityError } from './entity-error';

/**
 * What the caller was doing with the column, as the cause words it. A closed list so every site
 * says the same thing about the same use, and so the fix can tell an order from an equality.
 */
export type SealedUse =
  | 'a filter'
  | 'an order'
  | 'a grouped count'
  | 'an aggregate'
  | "a filtered write's filter"
  | 'an upsert conflict target'
  | 'an index'
  | 'a uniqueness rule'
  | 'an invariant';

/**
 * A sealed column where the DATABASE would have to compare it. It holds ciphertext: an opaque
 * column seals with a fresh IV, so two equal values never match and nothing can be found by it;
 * a `lookup` column seals deterministically, so equality — and only equality — means something.
 *
 * Two fixes, because they are two different mistakes: asking an opaque column anything is repaired
 * by declaring `lookup` (and the fix says what that costs), while asking a lookup column for an
 * order or a range has no declaration that repairs it.
 */
export const sealedPredicate = (
  entityName: string,
  column: string,
  use: SealedUse,
  lookup: boolean,
): EntityError =>
  // The opaque refusal FIRST: it is the one an author meets first, and the first literal in a
  // factory is what `x errors explain` prints.
  !lookup
    ? new EntityError({
        code: 'X_ENTITY_SEALED_PREDICATE',
        cause: `${entityName}.${column} is sealed and was named in ${use} — the database holds ciphertext sealed with a fresh IV, so no two values match and nothing there can find, order or group by it`,
        fix: `find the row by another column, or declare ${entityName}.${column} as text().sealed({ lookup: true }) to allow equality in where() and .unique() — equal plaintexts then store as visibly equal ciphertexts, so never for a low-entropy value, and rows already stored must be written again before they match`,
      })
    : new EntityError({
        code: 'X_ENTITY_SEALED_PREDICATE',
        cause: `${entityName}.${column} is sealed for lookup and was named in ${use} that is not an equality — the database holds ciphertext, and a deterministic seal preserves equality and nothing else: no order, no range, no like`,
        fix: `match it by equality — where({ ${column}: value }) or andWhere('${column}', 'in', values) — and order or range by a column that is not sealed`,
      });

/**
 * An equality on a lookup column whose operand is not a string. The column stores ciphertext or
 * NULL, so a number or an object would match no row — the same answer as "nobody has it". The
 * value itself is never echoed: it is the secret's plaintext, or close to it.
 */
export const sealedLookupValue = (
  entityName: string,
  column: string,
  shape: 'value' | 'list',
): EntityError =>
  new EntityError({
    code: 'X_ENTITY_SEALED_PREDICATE',
    cause: `${entityName}.${column} is sealed for lookup and was matched against a ${shape === 'list' ? 'list holding a value' : 'value'} that is not a string — the column holds sealed strings or NULL, so the filter could only ever match nothing`,
    fix: `pass the plaintext as a string — where({ ${column}: String(value) }) — or null to ask for the rows where ${entityName}.${column} is NULL`,
  });

/**
 * A row to insert that lacks a required sealed column. The driver would refuse it anyway ("is
 * required and has no default"), but in words that send the reader to the entity — and the usual
 * cause is one line above the call: a repository row does not ENUMERATE a sealed property, so
 * `{ ...row }` leaves it behind. The rewrite names it, which is the one way to copy a secret.
 */
export const sealedMissing = (entityName: string, column: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.${column}: is required, sealed, and missing from the row to insert — a row read from the repository does not enumerate a sealed column, so a spread ({ ...row }) or an Object.assign copy leaves it behind`,
    fix: `{ ...row, ${column}: row.${column} }   # in the ${entityName} insert()/insertAll()/upsertAll() call: a sealed column is copied by name, never by spread`,
  });

/** A sealed column listed in `$view([...])`. A view is what leaves the server. */
export const sealedInView = (entityName: string, column: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_SEALED_IN_VIEW',
    cause: `${entityName}.$view([...]) names ${column}, which is sealed — a view is an action's output, an OpenAPI schema and an MCP tool result, and a sealed column leaves the server through none of them`,
    fix: `remove '${column}' from the $view([...]) list — server code reads it off the row; a caller that must be shown it gets its own field on a t.object output, set by the handler`,
  });

/**
 * `.unique()` on a column sealed without `lookup`, refused on the chain — before any entity holds
 * the column, so there is no entity to name and the fix is the rewritten chain.
 */
export const sealedUniqueOpaque = (): EntityError =>
  new EntityError({
    code: 'X_ENTITY_SEALED_PREDICATE',
    cause:
      'column.sealed: a sealed column cannot be unique without lookup — uniqueness is the database comparing ciphertexts, and an opaque seal draws a fresh IV, so two equal values never collide',
    fix: 'text().sealed({ lookup: true }).unique() — equal plaintexts then store as visibly equal ciphertexts, so never for a low-entropy value',
  });

/**
 * A link a sealed column cannot take — a default, a key, the tenant, a foreign key, a search
 * source. Raised on the chain, before any entity exists, so the caller supplies the EDIT, exactly
 * as `refuse.ts` has it; it constructs the error itself so `fix-scan.ts` reads each call's fix.
 */
export const refuseSealed = (link: string, why: string, fix: string): never => {
  throw new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `column.sealed: a sealed column cannot be ${link} — ${why}`,
    fix,
  });
};
