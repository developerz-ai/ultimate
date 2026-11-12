// One `AuditRecord` as its `x_audit` row: the allow-list projection both the one-row insert and
// group commit's many-row insert bind, so the two statements cannot drift apart on a column.

import type { Actor } from '@ultimat3/core';
import { uuidV7 } from '@ultimat3/core';
import type { AuditRecord } from './audit';
import { auditableInput } from './audit-input';

/**
 * The columns a row binds, in `SQL_AUDIT_INSERT`'s parameter order (`audit-postgres.ts`) — and the keys of a
 * `writeMany` row, so the one-row and the many-row statement read ONE projection (`rowOf`).
 */
export const AUDIT_COLUMNS = [
  'id',
  'at',
  'action',
  'mutator',
  'surface',
  'outcome',
  'replayed',
  'idempotency_key',
  'failure_code',
  'actor_id',
  'actor_kind',
  'org_id',
  'on_behalf_of_id',
  'on_behalf_of_kind',
  'request_id',
  'trace_id',
  'locale',
  'tz',
  'build_id',
  'role',
  'input',
  'primitive',
] as const;

export type AuditRow = Readonly<Record<(typeof AUDIT_COLUMNS)[number], unknown>>;

/** One record as its row, keyed and ordered as `AUDIT_COLUMNS` — both statements bind this. */
export function rowOf(record: AuditRecord): AuditRow {
  const actor = record.ctx.actor;
  const at = record.at instanceof Date && !Number.isNaN(record.at.getTime()) ? record.at : null;
  const onBehalfOf = onBehalfOfOf(actor);
  const input = auditableInput(record.input);
  return {
    id: uuidV7(),
    at: at === null ? null : at.toISOString(),
    // `name`, into the column the seam named before reads were audited: renaming it is a data
    // migration for every installed table, and the value it holds is the same.
    action: record.name,
    mutator: record.mutator,
    surface: record.surface,
    outcome: record.outcome,
    replayed: record.replayed,
    idempotency_key: record.idempotencyKey,
    failure_code: record.failure?.code ?? null,
    actor_id: actor.id,
    actor_kind: actor.kind,
    org_id: actor.orgId ?? null,
    on_behalf_of_id: onBehalfOf?.actorId ?? null,
    on_behalf_of_kind: onBehalfOf?.actorKind ?? null,
    request_id: record.ctx.requestId,
    trace_id: record.ctx.traceId,
    locale: record.ctx.locale,
    tz: record.ctx.tz,
    build_id: record.ctx.buildId,
    role: record.ctx.role,
    // `undefined` in means a parse that never produced an input, which is a NULL column and
    // not the four characters `JSON.stringify(undefined)` does not produce either.
    input: input === undefined ? null : JSON.stringify(input),
    primitive: record.primitive,
  };
}

/**
 * Both halves of an impersonation, recorded and interpreted as NEITHER. `actor_id` is who the
 * framework ran the attempt as and `on_behalf_of_*` is what `impersonate()` recorded; which of
 * them an app calls "who did this" is the convention four apps model four ways, so the row carries
 * the two facts and takes no position between them.
 *
 * Read through a guard rather than off the type: `Actor.onBehalfOf` is optional, and an actor
 * minted by an app's own `resolveToken` is a plain object nothing in this package validated.
 */
function onBehalfOfOf(actor: Actor): { actorId: string; actorKind: string } | null {
  const origin: unknown = actor.onBehalfOf;
  if (typeof origin !== 'object' || origin === null) return null;
  const record = origin as Record<string, unknown>;
  const actorId = record['actorId'];
  const actorKind = record['actorKind'];
  if (typeof actorId !== 'string' || typeof actorKind !== 'string') return null;
  return { actorId, actorKind };
}
