// One structured line per `tools/call`, whatever the outcome — including the outcomes that
// deliberately tell the caller nothing.
//
// The three-outcome model works by giving a prober no signal. That is a property of the
// ANSWER, not of the system: enumeration is a pattern across many requests, so the refusal
// that reveals nothing to the caller still has to be visible to whoever reads the logs.
// Hence ToolNotFound is audited at `warn` — a run of them is the detectable shape of a name
// walk. Fields carry the decision, never the data it was made about.

import type { LogFields, Logger } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import type { McpCaller } from './registry';

/** What happened to one `tools/call`. The three security outcomes, plus the two that are not. */
export type McpOutcome =
  /** Ran, and the tool answered. */
  | 'ok'
  /** OUTCOME 1: absent, or hidden from this caller's role. Answered ToolNotFound. */
  | 'hidden'
  /** OUTCOME 2: visible, but the connection's token lacks the tool's scope. */
  | 'scope-denied'
  /** OUTCOME 3: ran, and the tool's own policy refused this input. */
  | 'policy-denied'
  /** Arguments failed the schema the agent was handed. Not an authz outcome. */
  | 'invalid-args'
  /**
   * The handler threw something that is not an authz denial: a non-authz framework refusal
   * (`db.migrate` aimed at prod), or a bug. Both want a human — a projected action rejecting
   * input MCP already validated means the JSON Schema and the real schema have drifted.
   */
  | 'failed';

/**
 * Codes that mean authz said no, wherever in the stack it decided. `X_POLICY_DENIED` used to sit
 * here and matched nothing: `@ultimat3/policy` owns the denial and throws `X_FORBIDDEN`, so the
 * entry classified a code no build can produce — and every real denial that reached it still had
 * to be recognised by one of the other two.
 */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  'X_ADMIN_DENIED',
  'X_FORBIDDEN',
  'X_UNAUTHENTICATED',
]);

/**
 * Codes that mean the CALLER got the arguments wrong, in a way the published JSON Schema could
 * not have refused. `X_ADMIN_INVALID` is the case: `@ultimat3/admin` publishes a `type` per field
 * and nothing else, so an entity's own rules are the first thing a value meets, and a mistyped
 * `admin.create` is a client misreading a schema — `invalid-args`, at `info`.
 *
 * `X_INPUT_INVALID` deliberately stays OUT: a projected action publishes its whole schema, so
 * input this server already validated failing inside the action means the two have drifted, and
 * that wants a human.
 */
const ARGUMENT_CODES: ReadonlySet<string> = new Set(['X_ADMIN_INVALID']);

/** Classify a code a tool threw. Denials are outcome 3; everything else wants a human. */
export function outcomeForCode(code: string): McpOutcome {
  if (DENIAL_CODES.has(code)) return 'policy-denied';
  return ARGUMENT_CODES.has(code) ? 'invalid-args' : 'failed';
}

/**
 * Classify a result a tool RENDERED rather than threw.
 *
 * A tool may answer `isError` itself — `@ultimat3/admin` does, so the model reads code/cause/fix
 * instead of a transport failure — and that answer used to be audited `policy-denied` at `warn`
 * whatever it refused for. So a malformed `admin.create` landed in the bucket this file exists to
 * make alertable: every refusal a prober can drive. A result that NAMES its code goes through
 * `outcomeForCode`, the same classifier a thrown one goes through; one that names none keeps the
 * conservative reading, because a tool cannot be assumed to have refused for a benign reason.
 */
export function outcomeForResult(result: {
  readonly isError?: boolean;
  readonly code?: string;
}): McpOutcome {
  if (result.isError !== true) return 'ok';
  return result.code === undefined ? 'policy-denied' : outcomeForCode(result.code);
}

export interface McpAuditEntry {
  readonly tool: string;
  readonly outcome: McpOutcome;
  readonly caller: McpCaller;
  /** The scope the call needed, on a `scope-denied` outcome. */
  readonly scope?: string;
  /** The `X_*` code the outcome carried, when it carried one. */
  readonly code?: string;
}

/**
 * Severity per outcome. Every refusal a prober can drive is `warn` so one alert rule covers
 * the whole enumeration surface; `invalid-args` is a well-behaved client misreading a schema,
 * and an unexpected throw is the only `error` because it is the only one that is a bug.
 */
const LEVEL = Object.freeze<Record<McpOutcome, 'info' | 'warn' | 'error'>>({
  ok: 'info',
  hidden: 'warn',
  'scope-denied': 'warn',
  'policy-denied': 'warn',
  'invalid-args': 'info',
  failed: 'error',
});

/**
 * Audit one call. `log` is a parameter so a test can read the line it produced; production
 * callers pass nothing and get the process logger, which is the only sink — there is no
 * switch that turns auditing off.
 *
 * Deliberately NOT logged: the call's arguments and anything the tool loaded. A denial reason
 * that names `post p_42 in org o_9` is a row leak wearing an audit line's clothes.
 */
export function auditToolCall(entry: McpAuditEntry, log: Logger = logger): void {
  const fields: LogFields = {
    surface: 'mcp',
    tool: entry.tool,
    outcome: entry.outcome,
    actor: entry.caller.actor.id,
    actorKind: entry.caller.actor.kind,
    ...(entry.caller.role === undefined ? {} : { role: entry.caller.role }),
    ...(entry.scope === undefined ? {} : { scope: entry.scope }),
    ...(entry.code === undefined ? {} : { code: entry.code }),
  };
  // `<subsystem>.<event>.<outcome>`, matching every other structured line in the framework,
  // so `x logs --json | grep mcp.tool-call.hidden` is the whole enumeration alert.
  log[LEVEL[entry.outcome]](`mcp.tool-call.${entry.outcome}`, fields);
}
