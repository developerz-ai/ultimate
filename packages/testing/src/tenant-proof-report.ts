// The tenant proof, as `x exercise` reports it: one line per finding — primitive, leg, and the path
// of A's canary in B's answer or the table and id of A's changed row — and one coded finding each
// for the gate to fail on. Only paths, tables and seeded ids are printed: never a bound value.

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

/** `B with A's ids, before A ran: output.items[0].url` — where, never what. */
const where = (finding: TenantFinding): string =>
  finding.code === 'X_TENANT_LEAK'
    ? `${finding.path ?? 'output'}`
    : `${finding.table ?? '?'} row ${finding.id ?? '?'}`;

/** Every finding of every crossed record, one line each: `action readPost · before · output.url`. */
export function tenantFindingLines(records: readonly ExerciseRecord[]): readonly string[] {
  return records.flatMap((record) =>
    record.tenant?.verdict === 'crossed'
      ? record.tenant.findings.map(
          (finding) =>
            `${record.kind} ${record.name} · ${finding.leg} · ${finding.code} ${where(finding)}`,
        )
      : [],
  );
}

const causeOf = (record: ExerciseRecord, finding: TenantFinding): string =>
  finding.code === 'X_TENANT_LEAK'
    ? `${record.kind} ${record.name}, called by tenant B with tenant A's ids ${LEG[finding.leg]}, handed back A's seeded data at ${where(finding)}: a read reached A's row by an id the caller chose, past the tenant guard`
    : `${record.kind} ${record.name}, called by tenant B with tenant A's ids ${LEG[finding.leg]}, changed A's ${where(finding)}: a write reached A's row by an id the caller chose, past the tenant guard`;

/**
 * One coded finding per tenant finding. The fix reruns the one primitive: what it reads or writes
 * by input id goes through the repository scoped to `ctx.actor` (or `crossTenant()` with a public
 * policy, when it truly spans tenants) — which read, only the handler shows.
 */
export function tenantProofFindings(
  records: readonly ExerciseRecord[],
): readonly TenantProofFinding[] {
  return records.flatMap((record) => {
    if (record.tenant?.verdict !== 'crossed') return [];
    const name = renderFixShellArg(record.name, '<primitive>');
    return record.tenant.findings.map(
      (finding): TenantProofFinding => ({
        code: finding.code,
        cause: causeOf(record, finding),
        fix: `x exercise ${name} --json — then read ${finding.code === 'X_TENANT_LEAK' ? 'the row behind ' : ''}${where(finding)} through the repository scoped to ctx.actor, never by the input id alone`,
        at: `${record.kind} ${record.name}`,
      }),
    );
  });
}
