// Single responsibility: which declared tables the drift step expects a migration to have made
// `REPLICA IDENTITY FULL` — the same set `x db gen` emits the ALTER for (`replicaIdentityTables`),
// or that command's own refusal as a finding. A tier-3 fact no entity carries, so no source hash
// moves when a channel with params is added over a table that already exists.

import { describeQueries } from '@ultimat3/query';
import { QuerySubscribesUnknownError, replicaIdentityTables } from './db-subscribes';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';
import { findingFrom } from './output';

/** The tables needing FULL, given the tables the app's entities declare. Injected for tests. */
export type ReplicaIdentityWanted = (tables: ReadonlySet<string>) => readonly string[];

/**
 * The app's own answer: its live queries' `subscribes:` plus every params channel's `records`
 * tables, read off the registries `loadApp` filled. One function with `db-generate.ts`, so the gate
 * can never expect an identity the generator would not grant, or miss one it would.
 */
export const appReplicaIdentity: ReplicaIdentityWanted = (tables) =>
  replicaIdentityTables(describeQueries(), tables);

export type WantedIdentity =
  | { readonly tables: ReadonlySet<string> }
  | { readonly finding: Finding };

/**
 * `x db gen` refuses a `subscribes:` name no entity declares (`X_QUERY_SUBSCRIBES_UNKNOWN`), and the
 * gate reports the same refusal rather than letting it escape the step: every other throw is a
 * defect in this process and is rethrown as one.
 */
export function wantedReplicaIdentity(
  wanted: ReplicaIdentityWanted,
  tables: ReadonlySet<string>,
): WantedIdentity {
  try {
    return { tables: new Set(wanted(tables)) };
  } catch (error) {
    if (!(error instanceof QuerySubscribesUnknownError)) throw error;
    return { finding: { ...findingFrom(error), at: MIGRATIONS_DIR } };
  }
}
