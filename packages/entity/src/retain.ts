// Single responsibility: `entity({ retain: { after, on } })` checked where it is written. The window
// is required and the app's — no default anywhere; `on` is an indexed timestamp, or every sweep is a
// table scan; and `appendOnly` beside it is refused, because that trigger refuses every delete.

import { retainInvalid } from '@ultimat3/db';
import { parseDuration } from '@ultimat3/time';
import { columnName } from './column';
import { EntityError } from './errors';
import type { AnyColumn, IndexDef } from './types';

/** What `retain` declares: rows whose `on` is older than `after` are swept by `purge()`. */
export interface RetainInit<K extends string = string> {
  readonly after: string;
  readonly on: K;
}

/** The checked declaration: the window in milliseconds and both spellings of the column. */
export interface Retain {
  readonly after: string;
  readonly afterMs: number;
  /** The property, as a row names it. */
  readonly on: string;
  /** The physical column, as the sweep's statement names it. */
  readonly column: string;
}

const windowMs = (entity: string, after: unknown): number => {
  if (typeof after !== 'string' || after.trim() === '') {
    throw retainInvalid(entity, "names no after window — the window is the app's to choose");
  }
  let ms: number;
  try {
    ms = parseDuration(after);
  } catch {
    throw retainInvalid(entity, `"${after}" is not a duration like '90d' or '2w'`);
  }
  if (!(ms > 0))
    throw retainInvalid(entity, `"${after}" is no window: it must be longer than zero`);
  return ms;
};

/** `null` when `retain` is absent. Every refusal raised here is at declaration. */
export function retainOf(
  entity: string,
  init: RetainInit | undefined,
  columns: readonly (readonly [string, AnyColumn])[],
  indexes: readonly IndexDef[],
  appendOnly: boolean,
): Retain | null {
  if (init === undefined) return null;
  if (appendOnly) {
    throw retainInvalid(
      entity,
      'is appendOnly: its trigger refuses every delete, a sweep included',
    );
  }
  const afterMs = windowMs(entity, init.after);
  const column = columns.find(([property]) => property === init.on)?.[1];
  if (column === undefined || column.$meta.kind !== 'timestamptz') {
    throw retainInvalid(entity, `retain.on "${String(init.on)}" is no timestamp() column of it`);
  }
  const physical = columnName(init.on, column.$meta);
  if (!indexes.some((index) => index.columns[0] === physical)) {
    throw new EntityError({
      code: 'X_ENTITY_RETAIN_UNINDEXED',
      cause: `entity "${entity}" retains by ${init.on}, and no index starts with it: every sweep would read the whole table`,
      fix: `x db gen "retain index"   # after adding { on: ['${init.on}'] } to indexes in entity('${entity}')`,
    });
  }
  return { after: init.after, afterMs, on: init.on, column: physical };
}
