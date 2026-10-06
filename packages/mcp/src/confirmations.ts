// `mcpConfirmations` — human confirmation for named MCP tools, as a FACTORY OVER `action`, never a
// ninth primitive. What it returns IS the decision action (`{ id, decision: 'approve' | 'reject' }`):
// registered like any other, it has its route, OpenAPI operation, typed client and audit record, and
// its policy is decided by `guard()` like every other write. The gate the agent meets lives in
// `confirmation-gate.ts`, applied by `defineAppMcp({ confirmations })`.

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Clock, UltimateError } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';
import type { KnownPermission, PolicyArgs, PolicyDecision } from '@ultimat3/policy';
import { can, denied } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import {
  McpConfirmationDecidedError,
  McpConfirmationExpiredError,
  McpConfirmationToolUnknownError,
  McpConfirmationUnknownError,
} from './confirmation-errors';
import type { McpConfirmation, McpConfirmationStore } from './confirmation-store';

/** Ten minutes: long enough for a person to read a request, short enough to go stale. */
export const DEFAULT_MCP_CONFIRMATION_TTL_MS = 600_000;

const decisionInput = () =>
  t.object({ id: t.uuid, decision: t.enum(['approve', 'reject'] as const) });

const decisionOutput = () =>
  t.object({
    id: t.string,
    tool: t.string,
    status: t.enum(['approved', 'rejected'] as const),
    decidedAt: t.date,
    expiresAt: t.date,
  });

type DecisionInput = ReturnType<typeof decisionInput>;
type DecisionOutput = ReturnType<typeof decisionOutput>;

/** What a decision is asked with: the confirmation's id and the verdict. */
export interface McpConfirmationDecision {
  readonly id: string;
  readonly decision: 'approve' | 'reject';
}

export interface McpConfirmationsInput<TTools extends string = string> {
  /** The tools whose every call waits for a person. Each must be one the server projects. */
  readonly tools: readonly TTools[];
  /** `memoryConfirmationStore()` for a test or `x dev`; `postgresConfirmationStore()` for a fleet. */
  readonly store: McpConfirmationStore;
  /** What the deciding actor must hold — the action's permission, read by `can()`. */
  readonly permission: KnownPermission;
  /**
   * WHO may decide WHICH confirmation — the app's rule, over the decider and the loaded row
   * (`row.orgId`, `row.actorId`): "an admin, or the user whose agent asked". Absent, anyone holding
   * `permission` decides any row. An agent never decides one whatever this says.
   */
  readonly check?: (args: PolicyArgs<unknown, McpConfirmation>) => boolean | PolicyDecision;
  /** How long a confirmation stays decidable and usable. Defaults to `DEFAULT_MCP_CONFIRMATION_TTL_MS`. */
  readonly ttlMs?: number | undefined;
  /** Stamps creation, expiry and decision. Defaulted, never read inline, so a test can move it. */
  readonly clock?: Clock | undefined;
  /** Record every decision through core's `AuditSink`, like any `audit: true` action. */
  readonly audit?: boolean | undefined;
}

/** The decision action, carrying what the gate needs. `defineAppMcp({ confirmations })` reads it. */
export interface McpConfirmations<TTools extends string = string>
  extends Action<DecisionInput, DecisionOutput> {
  /** The gated names, as written — typed, so a test or a screen can name one without a cast. */
  readonly tools: readonly TTools[];
  readonly store: McpConfirmationStore;
  readonly ttlMs: number;
  readonly clock: Clock;
}

/**
 * ```ts
 * // apps/web/app/orders/actions/confirm-refunds.ts
 * export const confirmRefunds = mcpConfirmations({
 *   tools: ['refundOrder'],
 *   store: postgresConfirmationStore({ executor }),
 *   permission: 'order:refund',
 *   check: ({ actor, row }) => row !== null && row.orgId === actor?.orgId,
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

  const decide = action({
    input: decisionInput(),
    output: decisionOutput(),
    // The agent refusal is IN the policy, so it is decided by `guard()` — the one authz path — and
    // reads as the same `X_FORBIDDEN` on every surface. A confirmation an agent can grant is a
    // confirmation the agent that asked can grant.
    policy: can<unknown, McpConfirmation>(input.permission, (args) => {
      if (args.actor?.kind === 'agent') return denied('mcp-confirmation.agent-decider');
      return check === undefined ? true : check(args);
    }),
    ...(input.audit === true ? { audit: true } : {}),
    row: async ({ input: asked }) => (await store.get(asked.id)) ?? null,
    async handle({ input: asked, ctx }) {
      const at = clock.now();
      const status: 'approved' | 'rejected' =
        asked.decision === 'approve' ? 'approved' : 'rejected';
      const decided = await store.decide(asked.id, status, ctx.actor.id, at);
      // The CAS failed or never applied: re-read and say which of the three it was.
      if (decided === undefined) throw refusalFor(await store.get(asked.id), asked.id);
      return {
        id: decided.id,
        tool: decided.tool,
        status,
        decidedAt: at,
        expiresAt: decided.expiresAt,
      };
    },
  });
  return Object.assign(decide, { tools: Object.freeze([...input.tools]), store, ttlMs, clock });
}

/** Why `decide` did not apply: no such row, a decision already taken, or the row lapsed. */
function refusalFor(row: McpConfirmation | undefined, id: string): UltimateError {
  if (row === undefined) return new McpConfirmationUnknownError(id);
  if (row.status !== 'pending')
    return new McpConfirmationDecidedError({ ...row, status: row.status });
  // Pending and not decidable: past its expiry, or consumed — which a pending row only ever is by
  // the agent's call being told it had expired.
  return new McpConfirmationExpiredError({ ...row, at: 'decision' });
}
