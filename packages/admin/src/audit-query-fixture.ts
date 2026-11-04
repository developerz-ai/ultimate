// One trail and one list of questions asked of it, answered by the memory log (`audit.test.ts`) and
// by the Postgres log on PGlite (`audit-pg.contract.test.ts`) — so the two stores cannot hold
// different ideas of what `outcome`, `since`, `until` and `before` mean.

import type { AuditDraft, AuditLog, AuditQuery } from './audit';

/** Every case reads only this entity of this tenant: the contract's table holds other tests' rows. */
const ENTITY = 'audit_cases';
const ORG = 'org-cases';

interface Seeded {
  readonly requestId: string;
  readonly at: string;
  readonly over: Partial<AuditDraft>;
}

/** Oldest first, as written. `r4` is an allowed read, and sits exactly on a day boundary. */
const TRAIL: readonly Seeded[] = [
  { requestId: 'r1', at: '2026-10-30T23:00:00.000Z', over: {} },
  {
    requestId: 'r2',
    at: '2026-10-31T00:00:00.000Z',
    over: { operation: 'delete', outcome: 'denied', actor: { id: 'u_b', orgId: ORG } },
  },
  { requestId: 'r3', at: '2026-10-31T12:00:00.000Z', over: { outcome: 'failed' } },
  { requestId: 'r4', at: '2026-11-01T00:00:00.000Z', over: { operation: 'detail', diff: [] } },
  { requestId: 'r5', at: '2026-11-01T06:00:00.000Z', over: { actor: { id: 'u_b', orgId: ORG } } },
];

/** The clock a store is built with, so each entry is stamped with its row's `at`. */
export function auditCaseClock(): () => Date {
  let next = 0;
  return () => new Date(TRAIL[next++]?.at ?? '2026-12-01T00:00:00.000Z');
}

/** Writes the trail into a log built with `auditCaseClock()`. */
export async function seedAuditCases(log: AuditLog): Promise<void> {
  for (const row of TRAIL) {
    await log.append({
      requestId: row.requestId,
      actor: { id: 'u_a', roles: ['admin'], orgId: ORG },
      operation: 'update',
      kind: 'operation',
      entity: ENTITY,
      entityId: 'row-1',
      permission: `${ENTITY}:write`,
      outcome: 'allowed',
      reason: 'admin.policy.all-granted',
      diff: [{ field: 'title', before: 'a', after: 'b' }],
      ...row.over,
    });
  }
}

export interface AuditQueryCase {
  readonly name: string;
  readonly query: AuditQuery;
  /** Page after the entry this request wrote: a `before` cursor read back from the store. */
  readonly after?: string;
  /** The answer's request ids, newest first. */
  readonly expected: readonly string[];
}

export const AUDIT_QUERY_CASES: readonly AuditQueryCase[] = [
  { name: 'no filter', query: {}, expected: ['r5', 'r4', 'r3', 'r2', 'r1'] },
  { name: 'outcome denied', query: { outcome: 'denied' }, expected: ['r2'] },
  { name: 'outcome allowed', query: { outcome: 'allowed' }, expected: ['r5', 'r4', 'r1'] },
  {
    name: 'since a bare date is that day’s first UTC instant, inclusive',
    query: { since: '2026-10-31' },
    expected: ['r5', 'r4', 'r3', 'r2'],
  },
  {
    name: 'until is exclusive: an entry exactly on the bound is out',
    query: { until: '2026-11-01' },
    expected: ['r3', 'r2', 'r1'],
  },
  {
    name: 'an instant with an offset is read in its own offset',
    query: { since: '2026-10-31T13:00:00+02:00' },
    expected: ['r5', 'r4', 'r3'],
  },
  {
    name: 'a window, both bounds',
    query: { since: '2026-10-31T00:00:00Z', until: '2026-11-01T00:00:00Z' },
    expected: ['r3', 'r2'],
  },
  {
    name: 'outcome with changes leaves the allowed read out',
    query: { outcome: 'allowed', changes: true },
    expected: ['r5', 'r1'],
  },
  {
    name: 'an actor and a bound',
    query: { actorId: 'u_a', until: '2026-11-01T06:00:00Z' },
    expected: ['r4', 'r3', 'r1'],
  },
  {
    name: 'before combined with a filter pages the filtered trail',
    query: { outcome: 'allowed' },
    after: 'r4',
    expected: ['r1'],
  },
  {
    name: 'before combined with a bound',
    query: { since: '2026-10-31' },
    after: 'r3',
    expected: ['r2'],
  },
];

/** What a store answers to one case, as request ids. */
export async function answerAuditCase(log: AuditLog, one: AuditQueryCase): Promise<string[]> {
  const scope = { entity: ENTITY, orgId: ORG } as const;
  const all = await log.entries(scope);
  const from = one.after === undefined ? undefined : all.find((e) => e.requestId === one.after);
  const before = from === undefined ? {} : { before: { at: from.at, id: from.id } };
  const page = await log.entries({ ...scope, ...one.query, ...before });
  return page.map((entry) => entry.requestId);
}

/** Bounds no store may read as "no bound": each is refused, never answered unfiltered. */
export const AUDIT_QUERY_REFUSALS: readonly AuditQuery[] = [
  { since: 'yesterday' },
  { until: '2026-02-30' },
  // A local time names no zone, and a store never invents one.
  { since: '2026-10-31T12:00:00' },
  // Nor does a form's minute: the screen appends the `Z` its UTC label promises, a store never.
  { until: '2026-10-31T12:00' },
];
