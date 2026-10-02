// The admin's predicate IR → the job store's own filters. The jobs list is read through
// `JobIntrospection`, whose `list` and bulk verbs answer a FIXED set of predicates; this is the one
// translation, shared by the list, a row's lookup and "all matching", and anything it cannot say
// is refused by name — never dropped, which would widen the operator's list (or their bulk call).

import type { BulkFilter, JobFilter, JobState } from '@ultimat3/jobs';
import { isJobState } from '@ultimat3/jobs';
import { AdminFilterInvalidError } from '../errors';
import type { AdminFilter } from '../registry';

/** The resource the job rows are, named once for every refusal. */
export const JOBS_RESOURCE = 'x_jobs';

/** What the store answers, in the URL's own spelling — the refusal's `known` list. */
const ANSWERED = [
  'f.id (starts with)',
  'f.id.eq',
  'f.name',
  'f.queue',
  'f.state',
  'f.tenantId',
  'f.createdAt.gte',
  'f.createdAt.lte',
] as const;

/** A translated `where`: the store's filter, and the one predicate it has no column for. */
export interface JobWhere {
  readonly filter: Omit<JobFilter, 'limit' | 'after' | 'before'>;
  /** `id eq`: the store matches a prefix, so an exact id is checked on the row. */
  readonly exactId?: string;
  /** Two predicates no row satisfies at once (`state = dead` and `state = done`). */
  readonly empty: boolean;
}

const refuse = (filter: AdminFilter, cause: string): never => {
  throw new AdminFilterInvalidError({
    entity: JOBS_RESOURCE,
    asked: `f.${filter.field}.${filter.op}`,
    cause,
    known: ANSWERED,
  });
};

const text = (filter: AdminFilter): string =>
  typeof filter.value === 'string'
    ? filter.value
    : refuse(filter, 'takes one value as text — the job store compares no list here');

const instantMs = (filter: AdminFilter): number => {
  const ms = Date.parse(text(filter));
  return Number.isFinite(ms) ? ms : refuse(filter, 'takes an ISO-8601 instant');
};

type Mutable = { -readonly [K in keyof JobWhere['filter']]: JobWhere['filter'][K] };

/** Set one key, or notice that two predicates contradict each other. */
function put<K extends keyof Mutable>(
  out: Mutable,
  key: K,
  value: NonNullable<Mutable[K]>,
  narrower: (a: NonNullable<Mutable[K]>, b: NonNullable<Mutable[K]>) => Mutable[K] | null,
): boolean {
  const held = out[key];
  if (held === undefined || held === null) {
    out[key] = value;
    return true;
  }
  const merged = narrower(held as NonNullable<Mutable[K]>, value);
  if (merged === null) return false;
  out[key] = merged;
  return true;
}

const same = <T>(a: T, b: T): T | null => (a === b ? a : null);

export function jobWhere(where: readonly AdminFilter[]): JobWhere {
  const out: Mutable = {};
  let exactId: string | undefined;
  let empty = false;
  const keep = (holds: boolean): void => {
    if (!holds) empty = true;
  };
  for (const filter of where) {
    const key = `${filter.field}.${filter.op}`;
    switch (key) {
      case 'state.eq': {
        const state = text(filter);
        if (!isJobState(state)) refuse(filter, 'is not a job state');
        keep(put(out, 'state', state as JobState, same));
        break;
      }
      case 'queue.eq':
        keep(put(out, 'queue', text(filter), same));
        break;
      case 'name.eq':
        keep(put(out, 'name', text(filter), same));
        break;
      case 'tenantId.eq':
        keep(put(out, 'tenantId', text(filter), same));
        break;
      // A job id is opaque and pasted from a log line by its first characters: the store's own
      // search is by prefix, so the id box's `contains` is answered as "starts with".
      case 'id.contains':
        keep(
          put(out, 'idPrefix', text(filter), (a, b) =>
            a.startsWith(b) ? a : b.startsWith(a) ? b : null,
          ),
        );
        break;
      case 'id.eq': {
        const id = text(filter);
        if (exactId !== undefined && exactId !== id) empty = true;
        exactId = id;
        keep(put(out, 'idPrefix', id, (a, b) => (b.startsWith(a) ? b : null)));
        break;
      }
      case 'createdAt.gte':
      case 'createdAt.gt': {
        const from = instantMs(filter) + (filter.op === 'gt' ? 1 : 0);
        put(out, 'createdFrom', from, (a, b) => Math.max(a, b));
        break;
      }
      // The store's upper bound is exclusive; `lte` includes its own millisecond.
      case 'createdAt.lt':
      case 'createdAt.lte': {
        const to = instantMs(filter) + (filter.op === 'lte' ? 1 : 0);
        put(out, 'createdTo', to, (a, b) => Math.min(a, b));
        break;
      }
      default:
        refuse(filter, 'is not a predicate the job store answers');
    }
  }
  if (
    out.createdFrom !== undefined &&
    out.createdTo !== undefined &&
    out.createdFrom >= out.createdTo
  ) {
    empty = true;
  }
  return { filter: out, ...(exactId === undefined ? {} : { exactId }), empty };
}

/**
 * The same `where` as a BULK verb's filter, which answers fewer predicates than a page does: a
 * state (required — "every job" is never one call), a queue, a name, a tenant. An id or a time
 * range is a selection the operator checks row by row, and is refused by name here.
 */
export function bulkWhere(where: readonly AdminFilter[]): BulkFilter | null {
  const translated = jobWhere(where);
  if (translated.empty) return null;
  const { state, queue, name, tenantId, idPrefix, createdFrom, createdTo } = translated.filter;
  const narrowed = idPrefix !== undefined || createdFrom !== undefined || createdTo !== undefined;
  if (narrowed || state === undefined) {
    throw new AdminFilterInvalidError({
      entity: JOBS_RESOURCE,
      asked: narrowed ? 'all matching, narrowed by id or time' : 'all matching, over every state',
      cause: narrowed
        ? 'cannot be one bulk call: the store bulk-edits by state, queue, name and tenant only — check the rows instead'
        : 'cannot be one bulk call: pick a state tab first, so "every job" is never one call',
      known: ['scope=<state>', 'f.queue', 'f.name', 'f.tenantId'],
    });
  }
  return {
    state,
    ...(queue === undefined ? {} : { queue }),
    ...(name === undefined ? {} : { name }),
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}
