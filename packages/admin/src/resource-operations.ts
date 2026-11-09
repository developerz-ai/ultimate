// Single responsibility: which operations an admin resource offers. Every one, by default, on a
// table; only the reads on a view entity (`entity({ view })`), whose rows Postgres derives, and on a
// `readOnly` one — so neither gets a create/edit/delete route, button or MCP tool, and an override
// asking for one is refused where it was declared.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';
import { ADMIN_OPERATIONS, type AdminOperation } from './permissions';
import type { AdminEntity } from './registry';

/** What a view offers. `search` reads, as `list` does. */
export const VIEW_OPERATIONS: readonly AdminOperation[] = ['list', 'detail', 'search'];

const READS: ReadonlySet<AdminOperation> = new Set(VIEW_OPERATIONS);

/** An admin resource over a view entity was declared with a write it can never perform. */
export class AdminViewWriteError extends UltimateError {
  constructor(input: { readonly entity: string; readonly writes: readonly AdminOperation[] }) {
    super({
      code: 'X_ADMIN_VIEW_WRITE',
      cause: `${input.entity} is a view (entity({ view })), whose rows Postgres derives, and its admin resource offers ${input.writes.join(', ')} — every one would be refused with X_ENTITY_VIEW_READ_ONLY`,
      fix: `x entities show ${renderFixShellArg(input.entity, '<entity>')} --json   # then drop operations from its admin resource (a view lists read-only), or name only ${VIEW_OPERATIONS.join(', ')}`,
    });
  }
}

/** An admin resource over a `readOnly` entity was declared with a write its repository refuses. */
export class AdminReadOnlyWriteError extends UltimateError {
  constructor(input: {
    readonly entity: string;
    readonly reason: string;
    readonly writes: readonly AdminOperation[];
  }) {
    super({
      code: 'X_ADMIN_READ_ONLY_WRITE',
      cause: `${input.entity} is readOnly (${input.reason}), and its admin resource offers ${input.writes.join(', ')} — every one would be refused with X_ENTITY_READ_ONLY`,
      fix: `x entities show ${renderFixShellArg(input.entity, '<entity>')} --json   # then drop operations from its admin resource (a readOnly table lists read-only), or name only ${VIEW_OPERATIONS.join(', ')}`,
    });
  }
}

export function operationsFor(
  entity: AdminEntity,
  declared: readonly AdminOperation[] | undefined,
): readonly AdminOperation[] {
  const isView = entity.$viewQuery !== undefined && entity.$viewQuery !== null;
  const reason = entity.$readOnly ?? null;
  if (!isView && reason === null) return declared ?? ADMIN_OPERATIONS;
  if (declared === undefined) return VIEW_OPERATIONS;
  const writes = declared.filter((operation) => !READS.has(operation));
  if (writes.length > 0) {
    throw isView
      ? new AdminViewWriteError({ entity: entity.$name, writes })
      : new AdminReadOnlyWriteError({ entity: entity.$name, reason: reason ?? '', writes });
  }
  return declared;
}
