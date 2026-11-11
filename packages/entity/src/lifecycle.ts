// Single responsibility: the three lifecycle declarations an entity may carry — `retain`, `history`
// and the `countedIn` counters kept on its columns — resolved once at `entity()` and projected onto its
// description. Split from `entity.ts`, which was at its ceiling; each rule is its own file's.

import type {
  CounterDescriptionLike,
  HistoryDescriptionLike,
  RetainDescriptionLike,
} from '@ultimat3/db';
import { columnName } from './column';
import { countersOf, describeCounter } from './counter';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import { type HistoryEntity, type HistoryInit, historyEntity, historyIgnored } from './history';
import type { Retain } from './retain';
import type { ColumnMap } from './types';

/** What `$describe()` gains, each absent unless declared so no other entity's hash moves. */
export interface LifecycleDescription {
  readonly history?: HistoryDescriptionLike;
  readonly counts?: readonly CounterDescriptionLike[];
  readonly retain?: RetainDescriptionLike;
  readonly historyOf?: string;
}

export interface LifecycleInput {
  readonly name: string;
  readonly table: string;
  readonly columns: ColumnMap;
  readonly primaryKey: readonly string[];
  readonly tenantColumn: string | null;
  readonly appendOnly: boolean;
  readonly history: HistoryInit | undefined;
  readonly historyOf: string | undefined;
}

/** The history entity, declared beside its parent — `null` when the entity keeps none. */
export function lifecycleHistory(input: LifecycleInput): HistoryEntity | null {
  if (input.history === undefined) return null;
  if (input.historyOf !== undefined || input.appendOnly) {
    throw invariantViolated(
      input.name,
      'history',
      input.appendOnly
        ? 'an appendOnly entity changes no row, so it has no history to keep — drop one of the two'
        : 'a history table keeps no history of its own',
    );
  }
  return historyEntity(input, input.history);
}

/**
 * The physical columns whose jsonb spelling is not the row's: an `int8`/`numeric` becomes a JSON
 * number a reader parses into a float, a `timestamptz` the session zone's offset. The trigger
 * stores these as the strings the memory driver keeps. Absent when empty, so no other hash moves.
 */
function exactColumns(core: EntityCore): Pick<HistoryDescriptionLike, 'text' | 'instants'> {
  const text: string[] = [];
  const instants: string[] = [];
  for (const [property, column] of Object.entries(core.$columns)) {
    const kind = column.$meta.kind;
    if (kind === 'bigint' || kind === 'numeric') text.push(columnName(property, column.$meta));
    if (kind === 'timestamptz') instants.push(columnName(property, column.$meta));
  }
  return {
    ...(text.length === 0 ? {} : { text }),
    ...(instants.length === 0 ? {} : { instants }),
  };
}

const physical = (core: EntityCore, property: string): string => {
  const column = core.$columns[property];
  return column === undefined ? property : columnName(property, column.$meta);
};

/** Read at describe time: a counter's thunk can only be answered once both modules evaluated. */
export function describeLifecycle(
  core: EntityCore,
  retain: Retain | null,
  historyOf: string | undefined,
): LifecycleDescription {
  const counters = countersOf(core);
  const history = core.$history;
  return {
    ...(history === null
      ? {}
      : {
          history: {
            table: history.$table,
            key: physical(core, core.$primaryKey[0] ?? ''),
            tenant: core.$tenantColumn === null ? null : physical(core, core.$tenantColumn),
            ignore: [
              ...new Set([
                ...counters.map((counter) => physical(core, counter.column)),
                ...historyIgnored(history),
              ]),
            ],
            ...exactColumns(core),
          },
        }),
    ...(counters.length === 0 ? {} : { counts: counters.map(describeCounter) }),
    ...(retain === null ? {} : { retain: { after: retain.after, on: retain.column } }),
    ...(historyOf === undefined ? {} : { historyOf }),
  };
}
