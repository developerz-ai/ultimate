// Single responsibility: say, in development and test, that a LIVE window is ordered by a text column
// the database orders by its collation while the matcher places a patched row by code point
// (`@ultimat3/entity`'s `byCodePoint`, Postgres' `C`). Refusing is a break, so it waits for `next`;
// until then it is one `log.record` warning per query, carrying `X_LIVE_ORDER_COLLATION`.

import { DEFAULT_ENVIRONMENT, logger, tryResolveEnvironment } from '@ultimat3/core';
import { entityForTable } from '@ultimat3/entity';
import type { QueryShape } from './shape';

/** The one log message this writes: a subscriber matches `log.record`'s `message` against it. */
export const LIVE_ORDER_COLLATION = 'query.live.order_collation';

/** The kinds Postgres orders by a collation. Every other kind orders the same in both readers. */
const COLLATED = new Set(['text', 'char']);

/** Once per query definition, never per subscribe: the declaration is what the author changes. */
const warned = new WeakSet<object>();

/**
 * The first DECLARED order key the matcher and the database order differently, or `undefined`. A
 * relation no entity declares has no kind to judge; a `text().collate('C')` column is code-point
 * order on both sides; the `id` tiebreak is `totalOrder`'s, and decides only inside a tie.
 */
export function divergentOrderKey(shape: QueryShape): string | undefined {
  const columns = entityForTable(shape.entity)?.$columns;
  if (columns === undefined) return undefined;
  for (const key of shape.orderBy) {
    // `hasOwn`, as `column-kinds.ts` reads it: a sort key is caller data, never a prototype key.
    const meta = Object.hasOwn(columns, key.column) ? columns[key.column]?.$meta : undefined;
    if (meta !== undefined && COLLATED.has(meta.kind) && meta.collation !== 'C') return key.column;
  }
  return undefined;
}

/**
 * Called by `toLiveQuery` at subscribe time. Silent in staging and production — the warning is for
 * the author, and staging exists to behave as production does — and after the first warning for
 * the same `target`. `env` is the test seam.
 */
export function reportLiveOrderCollation(
  target: object,
  name: string,
  shape: QueryShape,
  env?: Readonly<Record<string, string | undefined>>,
): void {
  if (warned.has(target)) return;
  const at = tryResolveEnvironment(env === undefined ? undefined : { env }) ?? DEFAULT_ENVIRONMENT;
  if (at !== 'development' && at !== 'test') return;
  const column = divergentOrderKey(shape);
  if (column === undefined) return;
  warned.add(target);
  logger.warn(LIVE_ORDER_COLLATION, {
    code: 'X_LIVE_ORDER_COLLATION',
    query: name,
    entity: shape.entity,
    column,
    cause: `live query "${name}" is ordered by the text column ${shape.entity}.${column}, which Postgres orders by its collation and the live matcher by code point, so a patched row can land where the next read does not put it`,
    fix: `${column}: text().collate('C')  # in entity ${shape.entity}, then x db gen "${shape.entity} ${column} collate C" — or order live query "${name}" by a non-text key: .orderBy('createdAt', 'desc').orderBy('id')`,
  });
}
