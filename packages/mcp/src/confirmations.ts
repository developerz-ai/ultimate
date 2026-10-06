// `mcpConfirmations` — human confirmation for named MCP tools, as a FACTORY OVER `action`, never a
// ninth primitive. What it returns IS the decision action (`{ id, decision: 'approve' | 'reject' }`):
// registered like any other, it has its route, OpenAPI operation, typed client and audit record, and
// its policy is decided by `guard()` like every other write. The gate the agent meets lives in
// `confirmation-gate.ts`, applied by `defineAppMcp({ confirmations })`.

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Clock, SealKeySource } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';
import type { KnownPermission, PolicyArgs, PolicyDecision } from '@ultimat3/policy';
import { can, denied } from '@ultimat3/policy';
import type { JsonValue } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { decideConfirmation } from './confirmation-decide';
import { McpConfirmationToolUnknownError } from './confirmation-errors';
import type { McpConfirmation, McpConfirmationStore } from './confirmation-store';

/** Ten minutes: long enough for a person to read a request, short enough to go stale. */
export const DEFAULT_MCP_CONFIRMATION_TTL_MS = 600_000;

const decisionInput = () =>
  t.object({
    id: t.uuid,
    decision: t.enum(['view', 'approve', 'reject'] as const),
    /** What the person approves: the `arguments` `view` returned. Required to approve. */
    arguments: t.optional(t.record(t.json())),
  });

const decisionOutput = () =>
  t.object({
    id: t.string,
    tool: t.string,
    status: t.enum(['pending', 'approved', 'rejected'] as const),
    decidedAt: t.nullable(t.date),
    expiresAt: t.date,
    arguments: t.record(t.json()),
  });

type DecisionInput = ReturnType<typeof decisionInput>;
type DecisionOutput = ReturnType<typeof decisionOutput>;

/**
 * What a decision is asked with. `view` reads the request exactly as the agent sent it; `approve`
 * must carry those `arguments` back, so what a person approves is what they were shown.
 */
export interface McpConfirmationDecision {
  readonly id: string;
  readonly decision: 'view' | 'approve' | 'reject';
  readonly arguments?: Readonly<Record<string, JsonValue>>;
}

export interface McpConfirmationsInput<TTools extends string = string> {
  /** The tools whose every call waits for a person. Each must be one the server projects. */
  readonly tools: readonly TTools[];
  /** `memoryConfirmationStore()` for a test or `x dev`; `postgresConfirmationStore()` for a fleet. */
  readonly store: McpConfirmationStore;
  /** What the deciding actor must hold — the action's permission, read by `can()`. */
  readonly permission: KnownPermission;
  /**
   * WHO may view and decide WHICH confirmation — the app's rule, over the decider and the loaded
   * row (`row.orgId`, `row.actorId`): "an admin, or the user whose agent asked". Absent, the decider
   * must be in the asking agent's org (`row.orgId === (actor.orgId ?? null)`) and a missing row is
   * refused; crossing tenants takes an explicit `check`. An agent never decides one whatever this says.
   */
  readonly check?: (args: PolicyArgs<unknown, McpConfirmation>) => boolean | PolicyDecision;
  /** How long a confirmation stays decidable and usable. Defaults to `DEFAULT_MCP_CONFIRMATION_TTL_MS`. */
  readonly ttlMs?: number | undefined;
  /** Stamps creation, expiry and decision. Defaulted, never read inline, so a test can move it. */
  readonly clock?: Clock | undefined;
  /** Record every decision through core's `AuditSink`, like any `audit: true` action. */
  readonly audit?: boolean | undefined;
  /** Where the seal key is read (`.secrets.key` / `ULTIMATE_SECRETS_KEY`). Defaults to the app's. */
  readonly sealKeys?: SealKeySource | undefined;
}

/** The decision action, carrying what the gate needs. `defineAppMcp({ confirmations })` reads it. */
export interface McpConfirmations<TTools extends string = string>
  extends Action<DecisionInput, DecisionOutput> {
  /** The gated names, as written — typed, so a test or a screen can name one without a cast. */
  readonly tools: readonly TTools[];
  readonly store: McpConfirmationStore;
  readonly ttlMs: number;
  readonly clock: Clock;
  readonly sealKeys: SealKeySource;
}

/**
 * ```ts
 * // apps/web/app/orders/actions/confirm-refunds.ts
 * export const confirmRefunds = mcpConfirmations({
 *   tools: ['refundOrder'],
 *   store: postgresConfirmationStore({ executor }),
 *   permission: 'order:refund',
 * });
 * // apps/web/app/mcp.ts
 * export const mcp = defineAppMcp({ include: 'exposed', confirmations: confirmRefunds, … });
 * ```
 */
export function mcpConfirmations<const TTools extends string>(
  input: McpConfirmationsInput<TTools>,
): McpConfirmations<TTools> {
  if (input.tools.length === 0)
    throw new McpConfirmationToolUnknownError({ unknown: [], known: [] });
  const ttlMs = finiteCount(
    'mcpConfirmations',
    'ttlMs',
    input.ttlMs ?? DEFAULT_MCP_CONFIRMATION_TTL_MS,
    1,
  );
  const clock = input.clock ?? systemClock;
  const { store, check } = input;
  const sealKeys: SealKeySource = input.sealKeys ?? {};

  const decide = action({
    input: decisionInput(),
    output: decisionOutput(),
    // The agent refusal is IN the policy, so it is decided by `guard()` — the one authz path — and
    // reads as the same `X_FORBIDDEN` on every surface. A confirmation an agent can grant is a
    // confirmation the agent that asked can grant.
    policy: can<unknown, McpConfirmation>(input.permission, (args) => {
      if (args.actor?.kind === 'agent') return denied('mcp-confirmation.agent-decider');
      return (check ?? sameTenant)(args);
    }),
    ...(input.audit === true ? { audit: true } : {}),
    row: async ({ input: asked }) => (await store.get(asked.id)) ?? null,
    // The view and the decision: state only — the policy above has already decided who.
    handle: ({ input: asked, ctx }) =>
      decideConfirmation({ store, clock, sealKeys }, asked, ctx.actor.id),
  });
  return Object.assign(decide, {
    tools: Object.freeze([...input.tools]),
    store,
    ttlMs,
    clock,
    sealKeys,
  });
}

/**
 * The default `check`: the decider is in the asking agent's org, and a missing row is refused — so
 * "unknown id" and "another tenant's id" are one answer. An org-less agent's row is decided only by
 * an org-less person; anything wider is an explicit `check`.
 */
function sameTenant(args: PolicyArgs<unknown, McpConfirmation>): boolean {
  return args.row !== null && args.row.orgId === (args.actor?.orgId ?? null);
}
