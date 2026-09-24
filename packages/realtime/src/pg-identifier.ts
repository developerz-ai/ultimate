// Single responsibility: the identifier charset every replication statement interpolates through.
// Its own module because the preflight and the publication both assert through it, and either
// importing the other for it would close a cycle.

import { ReplicationFailedError } from './errors';

/** Identifiers reach a simple query unparameterised, so the charset is the injection boundary. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

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
    fix: `rename the ${kind} to match [a-z_][a-z0-9_]* — it is interpolated into a replication command`,
  });
};
