// Single responsibility: the identifier charset every replication statement interpolates through.
// Its own module because the preflight and the publication both assert through it, and either
// importing the other for it would close a cycle.

import { renderFixShellArg } from '@ultimat3/core';
import { ReplicationFailedError } from './errors';

/** Identifiers reach a simple query unparameterised, so the charset is the injection boundary. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * `My-Slot` → `my_slot`: the nearest name the charset accepts. A name that would not start with a
 * letter is prefixed `x_`, not `_`: core's shell-safe set refuses a leading underscore.
 */
const foldIdentifier = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^(?=[^a-z])|^$/, 'x_');

/**
 * The one gate between a caller-supplied name and a simple query. `PgReplicationStream` checks its
 * slot, publication and entity names in its CONSTRUCTOR — a mistyped `REPLICATION_SLOT` is a
 * boot-time fact, and finding it at the first WAL read means a replicator that reported itself
 * started and then never delivered a change.
 */
export const assertIdentifier = (kind: string, value: string): string => {
  if (IDENTIFIER.test(value)) return value;
  throw new ReplicationFailedError({
    stage: 'preflight',
    detail: `${kind} "${value}" is not a lower-case postgres identifier`,
    // A slot and a publication are env-named (`REPLICATION_SLOT` / `REPLICATION_PUBLICATION`), so
    // their fix is the variable with the name folded into the charset; an entity is a table name.
    fix:
      kind === 'slot'
        ? `export REPLICATION_SLOT=${renderFixShellArg(foldIdentifier(value), 'x_replicator')}   # a lower-case postgres identifier: it is interpolated into a replication command`
        : kind === 'publication'
          ? `export REPLICATION_PUBLICATION=${renderFixShellArg(foldIdentifier(value), 'x_changes')}   # a lower-case postgres identifier: it is interpolated into a replication command`
          : `rename the ${kind} to match [a-z_][a-z0-9_]* — it is interpolated into a replication command`,
  });
};
