// One rule: how a declared meter moved, judged by what it refuses. A meter tightened refuses a
// caller the old build served and leaves every schema in the manifest untouched, so nothing else
// in the diff can see it — `diff-rate-limit.ts`'s reason, one period longer.

import type { ManifestChange } from './diff-change';
import type { ActionFact, MeterFact } from './schema';

type MeterReading = MeterFact | 'none' | 'unreadable';

const PERIOD_RANK = new Map<string, number>([
  ['hour', 0],
  ['day', 1],
  ['month', 2],
]);

/**
 * The most periods of `inner` one period of `outer` holds — UTC, so no DST-length day: 24 hours a
 * day, at most 31 days a month. Keyed `inner>outer`, a `Map` for the proto-index guard's reason.
 */
const MOST_NESTED = new Map<string, number>([
  ['hour>day', 24],
  ['day>month', 31],
  ['hour>month', 744],
]);

export function diffMeter(
  path: string,
  before: ActionFact,
  after: ActionFact,
): readonly ManifestChange[] {
  const declared = readMeter(before);
  const next = readMeter(after);
  if (declared === 'unreadable' || next === 'unreadable') return [];
  const at = `${path}.meter`;

  if (declared === 'none') {
    if (next === 'none') return [];
    return [
      {
        kind: 'breaking',
        path: at,
        detail: `meter introduced (${render(next)}); an unmetered caller can now be refused`,
      },
    ];
  }
  if (next === 'none') {
    return [{ kind: 'additive', path: at, detail: `meter removed (was ${render(declared)})` }];
  }

  const changes: ManifestChange[] = [];
  // The name is a counter's identity AND a key of the refusal's public `meta` a client may
  // switch on, so a rename is a wire change whatever the allowance did.
  if (declared.name !== next.name) {
    changes.push({
      kind: 'breaking',
      path: `${at}.name`,
      detail: `meter renamed ${declared.name} -> ${next.name}; a client reading meta.meter sees another name`,
    });
  }
  if (declared.warnAt !== next.warnAt) {
    changes.push({
      kind: 'internal',
      path: `${at}.warnAt`,
      detail: `warnAt ${String(declared.warnAt)} -> ${String(next.warnAt)}`,
    });
  }
  const allowance = classifyAllowance(declared, next);
  if (allowance !== undefined) {
    const detail = `meter ${allowanceWord(allowance)} ${render(declared)} -> ${render(next)}`;
    changes.push({ kind: allowance, path: at, detail });
  }
  return changes;
}

const allowanceWord = (kind: ManifestChange['kind']): string =>
  kind === 'breaking'
    ? 'tightened; a caller within the old allowance is refused:'
    : kind === 'additive'
      ? 'loosened'
      : 'moved, refusing every call on both sides:';

/**
 * Breaking iff some call pattern the old meter admitted is refused by the new one. Periods nest,
 * so the old meter's heaviest admitted load on one NEW period is `limit` when the new period is
 * no longer, and `limit × MOST_NESTED` when it is longer. Anything else that differs admits more.
 */
function classifyAllowance(from: MeterFact, to: MeterFact): ManifestChange['kind'] | undefined {
  if (from.limit === to.limit && from.period === to.period) return undefined;
  if (from.limit === null || to.limit === null) {
    // A per-call limit is the app's function of the tenant: no static number proves that a
    // tenant the old build served still is, so a move to or from one is breaking...
    if (from.limit !== to.limit) return 'breaking';
    // ...and two of them are taken as the same resolver over a moved period.
    return rank(to.period) > rank(from.period) ? 'breaking' : 'additive';
  }
  if (from.limit === 0 && to.limit === 0) return 'internal';
  const heaviest = from.limit * nested(from.period, to.period);
  return to.limit < heaviest ? 'breaking' : 'additive';
}

const rank = (period: string): number => PERIOD_RANK.get(period) ?? 0;

const nested = (inner: string, outer: string): number =>
  rank(outer) > rank(inner) ? (MOST_NESTED.get(`${inner}>${outer}`) ?? 1) : 1;

const render = (meter: MeterFact): string =>
  `${meter.limit === null ? 'per-call' : meter.limit}/${meter.period}@${meter.timeZone}`;

/** The shape `meterFact` writes; anything else is a file this reader cannot judge. */
function readMeter(fact: ActionFact): MeterReading {
  const value: unknown = fact.meter;
  if (value === undefined || value === null) return 'none';
  if (typeof value !== 'object') return 'unreadable';
  const record = value as Record<string, unknown>;
  const { name, period, timeZone, limit, warnAt } = record;
  if (typeof name !== 'string' || typeof period !== 'string' || !PERIOD_RANK.has(period)) {
    return 'unreadable';
  }
  // Only UTC exists; a zone this reader does not know cuts periods it cannot compare.
  if (timeZone !== 'UTC') return 'unreadable';
  if (limit !== null && !(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0)) {
    return 'unreadable';
  }
  const warning = typeof warnAt === 'number' ? warnAt : null;
  return {
    name,
    period: period as MeterFact['period'],
    timeZone,
    limit: limit as number | null,
    warnAt: warning,
  };
}
