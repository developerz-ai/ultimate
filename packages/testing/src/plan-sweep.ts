// The plan sweep: every distinct statement the exercise pass sent whose first relation is an app
// table, planned on the migrated database with sequential scans, bitmap scans and sorts disabled,
// judged by `plan-oracle.ts`, each red node named as the `indexes:` entry that answers it.
// Read-only: `PREPARE` in a read-only transaction whose settings die with it, then `DEALLOCATE`.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { isReservable, raw, sql, withReadTransaction } from '@ultimat3/db';
import './errors';
import type { PlanTableColumns } from './plan-oracle';
import { judgePlan } from './plan-oracle';
import type { PlanFinding } from './plan-sweep-fix';
import { planFindings } from './plan-sweep-fix';
import type { SeedEntity } from './seed-graph-shape';

/** What the pass's room kept of one statement text: who sent it, under which scan reason. */
export interface SentStatement {
  readonly primitives: ReadonlySet<string>;
  /** The `expectedSeqScan` reason in force when it was sent. */
  readonly scan?: string;
}

export interface PlanExempt {
  readonly statement: string;
  readonly reason: string;
}

/** One primitive's statements, planned. Only `findings` is red. */
export interface PlanProof {
  readonly planned: number;
  readonly findings: readonly PlanFinding[];
  /** A table that declared `scan`, or a statement under `expectedSeqScan`: why it may scan. */
  readonly exempt: readonly PlanExempt[];
  /** Generic planning refused it (an untyped parameter): listed and counted, never red. */
  readonly unplannable: readonly PlanExempt[];
}

/** The server cannot hand back a generic plan: no statement was judged, which is never a pass. */
export class QueryPlanUnavailableError extends UltimateError {
  constructor(version: string) {
    super({
      code: 'X_QUERY_PLAN_UNAVAILABLE',
      cause: `the gate's database answered server_version_num ${version}: below Postgres 12 there is no plan_cache_mode, so the plan sweep cannot read a generic plan and no statement was judged`,
      fix: 'DATABASE_URL= x verify --only exercise   # the embedded database answers every plan',
      meta: { version },
    });
  }
}

/** The planner's choices the sweep removes: what remains is what the schema can serve. */
const SETTINGS = {
  enable_seqscan: 'off',
  enable_bitmapscan: 'off',
  enable_sort: 'off',
  plan_cache_mode: 'force_generic_plan',
} as const;
const PREPARED = 'x_plan_sweep';
const FIRST_RELATION = /\b(?:from|into|update|join)\s+(?:"?\w+"?\.)?"?([A-Za-z_][\w$]*)"?/i;

/** `$1` … `$n`: the highest one is how many nulls `execute` passes. */
const parameterCount = (statement: string): number =>
  Math.max(0, ...[...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));

interface Planned {
  readonly plan?: unknown;
  readonly refused?: string;
}

async function explain(client: DbClient, statement: string): Promise<Planned> {
  const connection = isReservable(client) ? await client.reserve() : undefined;
  const on = connection ?? client;
  let prepared = false;
  try {
    const n = parameterCount(statement);
    const args = n === 0 ? '' : `(${Array.from({ length: n }, () => 'null').join(', ')})`;
    const rows = await withReadTransaction(
      async (tx) => {
        await tx.execute(raw(`prepare ${PREPARED} as ${statement}`));
        prepared = true;
        return tx.query<Record<string, unknown>>(
          raw(`explain (format json) execute ${PREPARED}${args}`),
        );
      },
      { settings: SETTINGS, client: on },
    );
    return { plan: rows[0]?.['QUERY PLAN'] };
  } catch (error) {
    return { refused: renderThrowable(error) };
  } finally {
    // A prepared statement outlives the transaction: left, the connection's next sweep collides.
    if (prepared) await on.execute(raw(`deallocate ${PREPARED}`));
    connection?.release();
  }
}

interface ProofBuilder {
  planned: number;
  readonly findings: PlanFinding[];
  readonly exempt: PlanExempt[];
  readonly unplannable: PlanExempt[];
}

/** Plan every statement `sent` holds, once each, and hand each primitive the verdicts of its own. */
export async function sweepPlans(
  client: DbClient,
  sent: ReadonlyMap<string, SentStatement>,
  entities: readonly SeedEntity[],
): Promise<ReadonlyMap<string, PlanProof>> {
  const tables = entities.filter((entity) => entity.$describe().view === undefined);
  const byTable = new Map(tables.map((entity) => [entity.$table, entity]));
  const judged: PlanTableColumns = new Map(
    tables
      .filter((entity) => entity.$describe().scan === undefined)
      .map((entity) => [entity.$table, new Set(entity.$describe().columns.map((c) => c.column))]),
  );
  const version = await client.one<{ readonly v: string }>(
    sql`select current_setting('server_version_num') as v`,
  );
  if (Number(version?.v ?? 0) < 120_000) throw new QueryPlanUnavailableError(version?.v ?? '?');

  const proofs = new Map<string, ProofBuilder>();
  const proofOf = (name: string): ProofBuilder => {
    const found = proofs.get(name);
    if (found !== undefined) return found;
    const made: ProofBuilder = { planned: 0, findings: [], exempt: [], unplannable: [] };
    proofs.set(name, made);
    return made;
  };
  for (const [statement, { primitives, scan }] of sent) {
    const table = FIRST_RELATION.exec(statement)?.[1];
    const entity = table === undefined ? undefined : byTable.get(table);
    if (entity === undefined) continue;
    const declared = entity.$describe().scan;
    const exemptBy = scan ?? declared;
    const planned = exemptBy === undefined ? await explain(client, statement) : {};
    for (const name of primitives) {
      const proof = proofOf(name);
      proof.planned += 1;
      if (exemptBy !== undefined) proof.exempt.push({ statement, reason: exemptBy });
      else if (planned.refused !== undefined) {
        proof.unplannable.push({ statement, reason: planned.refused });
      } else {
        proof.findings.push(...planFindings(statement, judgePlan(planned.plan, judged), byTable));
      }
    }
  }
  return proofs;
}
