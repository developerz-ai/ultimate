// The search index WRITE path: an installed external index hears every committed row change of a
// searchable entity through core's `entity.row` event — which `row-observer.ts` emits AFTER COMMIT,
// so a rollback indexes nothing. Insert/update/upsert/transition index the row; a delete removes it
// at the delete's instant. A failure is a log line, never the user's write; `reindex` repairs it.

import { isUltimateError, logger, renderThrowable, subscribe } from '@ultimat3/core';
import { entityNow } from './clock';
import type { EntityCore } from './entity';
import { getEntity } from './registry';
import { rowKey } from './row-key';
import type { SearchIndex } from './search-index';
import { searchDocumentOf } from './search-index';
import { answersInStatement } from './search-index-postgres';

/** The one log event a failed mirror writes — its fields name the entity, the op and the code. */
export const SEARCH_INDEX_WRITE_FAILED = 'entity.search-index.write-failed';

const unmirrored = (entity: string, op: string, cause: string, code?: string): void => {
  logger.warn(SEARCH_INDEX_WRITE_FAILED, {
    entity,
    op,
    ...(code === undefined ? {} : { code }),
    cause,
    fix: `reindex({ name: 'reindex-${entity}', entity, source, tenant: 'none' })   # rebuild the index, which missed this ${op}`,
  });
};

const failed = (entity: string, op: string, error: unknown): void =>
  unmirrored(entity, op, renderThrowable(error), isUltimateError(error) ? error.code : undefined);

/** The searchable entity an event names, or `undefined` for one nothing in the index reads. */
const searchableNamed = (name: string): EntityCore<unknown> | undefined => {
  const core = getEntity(name)?.core;
  return core === undefined || core.$search === null ? undefined : core;
};

/** One committed change, mirrored. Synchronous to the bus; the index call settles on its own. */
const mirror = (
  index: SearchIndex,
  entity: string,
  op: string,
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): void => {
  const core = searchableNamed(entity);
  if (core === undefined) return;
  try {
    if (after !== null) {
      index.index([searchDocumentOf(core, after)]).catch((error) => failed(entity, op, error));
      return;
    }
    // A delete whose row this process could not read (`before` is `null` when the key is not
    // `id`) names no id to remove — the gap `reindex` cannot close either, so it is logged.
    if (before === null) {
      unmirrored(entity, op, 'the deleted row was not read: its primary key is not id');
      return;
    }
    const tenantColumn = core.$tenantColumn;
    const tenant = tenantColumn === null ? null : before[tenantColumn];
    index
      .remove(
        { entity, tenant: typeof tenant === 'string' ? tenant : null },
        [rowKey(core, before)],
        entityNow().getTime(),
      )
      .catch((error) => failed(entity, op, error));
  } catch (error) {
    failed(entity, op, error);
  }
};

/**
 * Subscribe `index` to the write path, or nothing for the built-in Postgres index — its vector is
 * the row, so it costs a write nothing, not even `row-observer.ts`'s `before` read. Only the index
 * `searchIndex()` answers mirrors: a test's install over the boot's does not write to both.
 */
export const syncSearchIndex = (index: SearchIndex, current: () => SearchIndex): (() => void) => {
  if (answersInStatement(index)) return () => {};
  const rows = subscribe('entity.row', ({ payload }) => {
    if (current() !== index) return;
    mirror(index, payload.entity, payload.op, payload.before, payload.after);
  });
  // A filtered write names a count, not rows: nothing to mirror, so it is said out loud.
  const bulk = subscribe('entity.bulk', ({ payload }) => {
    if (current() !== index || searchableNamed(payload.entity) === undefined) return;
    unmirrored(
      payload.entity,
      `${payload.op}Where`,
      `${payload.rows} rows changed by a filtered write are not mirrored`,
    );
  });
  return () => {
    rows();
    bulk();
  };
};
