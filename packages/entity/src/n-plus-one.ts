// Which fix a repeated statement has earned. The relations the schema already declared decide it:
// a loop over a page reads what one `preload()` would have carried, so the map that names the
// relation is the map that writes the fix line — never a name this file invents.
//
// Nothing here counts anything. A ledger elsewhere decides that a shape repeated; this turns that
// verdict into the one error the surfaces render.

import type { EntityError, PreloadCandidate } from './errors';
import { nPlusOneQuery, nPlusOneWrite } from './errors';
import type { RelationKind } from './relations';
import { relationMap } from './relations';

/** One statement shape, repeated inside one request — a ledger's verdict, as this layer reads it. */
export interface StatementLoop {
  /** Which of the two codes this is: decided from the statement, upstream, never re-derived here. */
  readonly kind: 'read' | 'write';
  /** What repeated: `members.findById` when a repository sent it, else the statement's own text. */
  readonly subject: string;
  /** Statements of this shape in the request. Reported, not judged — the threshold is the ledger's. */
  readonly count: number;
  /** The entity the repository call named. Absent for hand-written SQL, which names no chain. */
  readonly entity?: string | undefined;
  /** The repository operation — `findById`, `insert`. Absent for the same reason. */
  readonly op?: string | undefined;
}

/**
 * Which relation kind would have carried the rows this operation read one at a time.
 *
 * A point lookup per row is the `belongsTo` side — fifty `members.findById` are one page's authors,
 * and `posts.preload('author')` is one statement for all of them. A filtered read per row is the
 * `hasMany` side — fifty `comments.findMany({ postId })` are one page's comment lists, and
 * `posts.preload('comments')` is the same one statement. Every other operation is left to the `in`
 * form: a repeated `count` or `countBy` is answered by `countBy`, and a preload attaches rows to a
 * page that a count never read.
 */
const PRELOADABLE_BY_OP: Readonly<Record<string, RelationKind>> = {
  findById: 'belongsTo',
  findMany: 'hasMany',
};

/**
 * Every page that could have preloaded these rows, in the map's own sorted order.
 *
 * The edges are read by their `to` end, because that is the entity the loop repeated on: a lookup
 * of `members` is fixed on whatever holds a `references()` to it, and this diagnostic only ever saw
 * the statement — never the `for … of` above it — so it cannot know which of those pages was being
 * iterated. Naming them all is what `preloadUnknownRelation` already does with relation names.
 */
export const preloadsFor = (
  entityName: string,
  op: string | undefined,
): readonly PreloadCandidate[] => {
  const kind = op === undefined ? undefined : PRELOADABLE_BY_OP[op];
  if (kind === undefined) return [];
  const candidates: PreloadCandidate[] = [];
  for (const relations of Object.values(relationMap())) {
    for (const relation of Object.values(relations)) {
      if (relation.kind !== kind || relation.to !== entityName) continue;
      candidates.push({ from: relation.from, relation: relation.name });
    }
  }
  return candidates;
};

/**
 * A schema whose relations cannot be named answers with the `in` form rather than with its own
 * complaint: `relationMap()` throws `X_INVARIANT_VIOLATED` on two foreign keys it cannot tell
 * apart, and a diagnostic that replaced the loop it was reporting with a schema error would hide
 * the N+1 behind a fault the loop did not cause — in a dev process, as an uncaught throw.
 */
const preloadsOrNone = (
  entityName: string,
  op: string | undefined,
): readonly PreloadCandidate[] => {
  try {
    return preloadsFor(entityName, op);
  } catch {
    return [];
  }
};

/** The read half: the preload the schema names, else the `in` form of the statement it repeated. */
const readLoop = (loop: StatementLoop): EntityError => {
  if (loop.entity === undefined) return nPlusOneQuery(loop.subject, loop.count, { form: 'sql' });
  // The destructure is what proves the fix has something to name — an empty candidate list is an
  // empty `preload` fix, which is the one thing the error contract refuses outright.
  const [first, ...rest] = preloadsOrNone(loop.entity, loop.op);
  if (first === undefined) {
    return nPlusOneQuery(loop.subject, loop.count, { form: 'in', entity: loop.entity });
  }
  return nPlusOneQuery(loop.subject, loop.count, { form: 'preload', candidates: [first, ...rest] });
};

/**
 * One repeated shape, as the error every surface renders. One entry point and not two, because the
 * caller already knows which of the two codes it holds and a second decision here is a second place
 * for the read and the write halves to disagree about what a loop is.
 */
export const nPlusOne = (loop: StatementLoop): EntityError =>
  loop.kind === 'read'
    ? readLoop(loop)
    : nPlusOneWrite(
        loop.subject,
        loop.count,
        loop.entity === undefined
          ? { form: 'sql' }
          : { form: 'bulk', entity: loop.entity, op: loop.op },
      );
