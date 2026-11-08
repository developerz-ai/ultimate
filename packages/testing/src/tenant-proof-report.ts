// The tenant proof, as `x exercise` reports it: one line per leg and code — primitive, leg, and the
// paths of A's canaries in B's answer or the tables and ids of A's changed rows — and one coded
// finding each for the gate to fail on. Only paths, tables and seeded ids: never a bound value.

import { renderFixShellArg } from '@ultimat3/core';
import type { ExerciseRecord, TenantFinding } from './exercise-report';

/** One coded finding, the shape `x exercise` hands the gate. */
export interface TenantProofFinding {
  readonly code: TenantFinding['code'];
  readonly cause: string;
  readonly fix: string;
  /** The primitive, by kind and name: the registry records no declaring file. */
  readonly at: string;
}

const LEG = { before: 'before A ran', after: 'after A ran' } as const;

/** Every finding of one leg and one code: one statement's leak, however many fields it carried. */
interface Group {
  readonly code: TenantFinding['code'];
  readonly leg: TenantFinding['leg'];
  readonly sweep: boolean;
  readonly where: string;
}

/** `output.items[0].url` — where, never what. */
const whereOne = (finding: TenantFinding): string =>
  finding.code === 'X_TENANT_LEAK'
    ? `${finding.path ?? 'output'}`
    : `${finding.table ?? '?'} row ${finding.id ?? '?'}`;

/**
 * Each distinct place once. Places differing only in a list index — three enqueues carrying the same
 * three fields — collapse to `[*]` with their count; a lone one keeps its index.
 */
const whereAll = (findings: readonly TenantFinding[]): string => {
  const counts = new Map<string, { readonly first: string; count: number }>();
  for (const finding of findings) {
    const place = whereOne(finding);
    const shape = place.replace(/\[\d+\]/g, '[*]');
    const seen = counts.get(shape);
    if (seen === undefined) counts.set(shape, { first: place, count: 1 });
    else seen.count += 1;
  }
  const entries = [...counts.entries()];
  const each = entries[0]?.[1].count ?? 1;
  if (each > 1 && entries.every(([, { count }]) => count === each)) {
    return `${entries.map(([shape]) => shape).join(', ')} (${each} each)`;
  }
  return entries
    .map(([shape, { first, count }]) => (count === 1 ? first : `${shape} (×${count})`))
    .join(', ');
};

const groupsOf = (findings: readonly TenantFinding[]): readonly Group[] => {
  const byKey = new Map<string, TenantFinding[]>();
  for (const finding of findings) {
    const key = `${finding.leg}\u0000${finding.code}\u0000${finding.sweep === true}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [finding]);
    else list.push(finding);
  }
  return [...byKey.values()].map((list) => {
    const head = list[0] as TenantFinding;
    return { code: head.code, leg: head.leg, sweep: head.sweep === true, where: whereAll(list) };
  });
};

const crossedGroups = (record: ExerciseRecord): readonly Group[] =>
  record.tenant?.verdict === 'crossed' ? groupsOf(record.tenant.findings) : [];

/** One line per leg and code of every crossed record: `action readPost · before · …`. */
export function tenantFindingLines(records: readonly ExerciseRecord[]): readonly string[] {
  return records.flatMap((record) =>
    crossedGroups(record).map(
      (group) => `${record.kind} ${record.name} · ${group.leg} · ${group.code} ${group.where}`,
    ),
  );
}

/**
 * B sends A's own first input, A's ids bound in only where it takes any: `{ occurrenceMs }` carries
 * none, and B still crosses when a statement it ran names no tenant. Both readings, always.
 */
const causeOf = (record: ExerciseRecord, group: Group): string =>
  group.code === 'X_TENANT_LEAK'
    ? `${record.kind} ${record.name}, called by tenant B with A's own input ${LEG[group.leg]}, handed back A's seeded data at ${group.where}: a read reached A's row past the tenant guard — by an id the caller chose, or by a statement no tenant predicate scopes`
    : `${record.kind} ${record.name}, called by tenant B with A's own input ${LEG[group.leg]}, changed A's ${group.where}: a write reached A's row past the tenant guard — by an id the caller chose, or by a statement no tenant predicate scopes`;

/**
 * A `tenant: 'none'` job has no actor's org to scope a read to: reading every org is its job, and
 * the one declaration the proof credits for that is a `crossTenant()` scope (`sweepReason`).
 */
const fixOf = (name: string, group: Group): string =>
  group.code === 'X_TENANT_WRITE_CROSSED'
    ? `x exercise ${name} --json — then write ${group.where} through the repository scoped to ctx.actor, never by the input id alone, nor by an unscoped statement`
    : group.sweep
      ? `x exercise ${name} --json — then wrap the read behind ${group.where} in ${name}'s run in crossTenant('<why ${name} reads every org>', async () => …) from @ultimat3/entity; the job's actor must hold tenancy:cross`
      : `x exercise ${name} --json — then read the row behind ${group.where} through the repository scoped to ctx.actor, never by the input id alone, nor by an unscoped statement`;

/**
 * One coded finding per leg and code. The fix reruns the one primitive: what it reads or writes by
 * input id goes through the repository scoped to `ctx.actor` — or, for a `tenant: 'none'` job's
 * read across every org, a `crossTenant()` scope. Which statement, only the handler shows.
 */
export function tenantProofFindings(
  records: readonly ExerciseRecord[],
): readonly TenantProofFinding[] {
  return records.flatMap((record) => {
    const name = renderFixShellArg(record.name, '<primitive>');
    return crossedGroups(record).map(
      (group): TenantProofFinding => ({
        code: group.code,
        cause: causeOf(record, group),
        fix: fixOf(name, group),
        at: `${record.kind} ${record.name}`,
      }),
    );
  });
}
