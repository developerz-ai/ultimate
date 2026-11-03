// `x doctor`'s statement bound: what the session in force actually reads, on demand — the boot's
// `X_DB_STATEMENT_BOUND_LOST` line, asked without booting. And the one fact a pooler changes about a
// worker: the wake is off, the poll answers instead. Allowed and cheap, so a line and never a finding.

import { type Role, resolveRole } from '@ultimat3/core';
import type { PoolerMode, StatementBound } from '@ultimat3/db';
import { DbError, lostStatementBound, postgresClient, statementBound } from '@ultimat3/db';
import { IDLE_POLL_CEILING_MS } from '@ultimat3/jobs';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { findingFrom } from './output';

export interface PoolerFact {
  readonly role: Role | undefined;
  readonly pooler: PoolerMode | undefined;
  /** `undefined` when there was no session to read: no external database, or a refusal. */
  readonly bound: StatementBound | undefined;
  /** The pooler refused this configuration: every other database probe would only repeat it. */
  readonly refused: Finding | undefined;
}

export const NO_POOLER_FACT: PoolerFact = {
  role: undefined,
  pooler: undefined,
  bound: undefined,
  refused: undefined,
};

/**
 * The I/O half, external databases only: `probeDatabase`'s rule. An unreachable server is
 * `database()`'s finding to make, so only a pooler's own refusal is reported from here.
 */
export async function poolerProbe(
  url: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<PoolerFact> {
  if (url === undefined || url.trim() === '') return NO_POOLER_FACT;
  let role: Role;
  let client: ReturnType<typeof postgresClient>;
  try {
    role = resolveRole({ env });
    client = postgresClient({ url, role, env, applicationName: 'x-doctor' });
  } catch (error) {
    return { ...NO_POOLER_FACT, refused: findingFrom(error) };
  }
  // The client's answer, so the mode reported is the mode it connected with.
  const { pooler } = client;
  try {
    return { role, pooler, bound: await statementBound(client), refused: undefined };
  } catch (error) {
    const refused =
      error instanceof DbError && error.code === 'X_DB_POOLER_OPTIONS_REFUSED'
        ? findingFrom(error)
        : undefined;
    return { role, pooler, bound: undefined, refused };
  } finally {
    await client.close();
  }
}

/** The rule, pure: a refusal, or a bound that is not the role's. */
export function poolerFindings(fact: PoolerFact): readonly Finding[] {
  if (fact.refused !== undefined) return [fact.refused];
  if (fact.bound === undefined || fact.role === undefined) return [];
  const lost = lostStatementBound(fact.bound, fact.role, fact.pooler);
  return lost === undefined ? [] : [findingFrom(lost)];
}

const readingOf = (reading: StatementBound['statementTimeout']): JsonValue => ({
  appliedMs: reading.applied,
  expectedMs: reading.expected,
});

/** The report, on a result `x doctor` already decided: `ok` and the findings stay as they came. */
export function withPoolerReport(result: CommandResult, fact: PoolerFact): CommandResult {
  if (fact.bound === undefined || fact.role === undefined) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const lines: string[] = [];
  const wakeOff = fact.role === 'worker' && fact.pooler === 'transaction';
  if (fact.pooler !== undefined) {
    lines.push(
      msg('cli.doctor.poolerBound', {
        pooler: fact.pooler,
        role: fact.role,
        statement: fact.bound.statementTimeout.applied,
        idle: fact.bound.idleInTransaction.applied,
      }),
    );
  }
  if (wakeOff) lines.push(msg('cli.doctor.poolerWakeOff', { ms: IDLE_POLL_CEILING_MS }));
  const statement: JsonValue = {
    role: fact.role,
    pooler: fact.pooler ?? null,
    statementTimeout: readingOf(fact.bound.statementTimeout),
    idleInTransaction: readingOf(fact.bound.idleInTransaction),
  };
  const wake: JsonValue = { off: true, pickupWithinMs: IDLE_POLL_CEILING_MS };
  return {
    ...result,
    data: {
      ...(data as Record<string, JsonValue>),
      statementBound: statement,
      ...(wakeOff ? { wake } : {}),
    },
    lines: [...(result.lines ?? []), ...lines],
  };
}
