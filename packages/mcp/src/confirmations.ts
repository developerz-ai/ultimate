// `mcpConfirmations` — human confirmation for named MCP tools, as a FACTORY OVER `action`, never a
// ninth primitive. What it returns IS the decision action (`{ id, decision: 'approve' | 'reject' }`):
// registered like any other, it has its route, OpenAPI operation, typed client and audit record, and
// its policy is decided by `guard()` like every other write. The gate the agent meets lives in
// `confirmation-gate.ts`, applied by `defineAppMcp({ confirmations })` for an MCP server and registered
// by name for an in-app agent's `agent({ tools })`.

import type { Action } from '@ultimat3/action';
import { action, registerToolGate } from '@ultimat3/action';
import type { Clock, SealKeySource } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';
import type { KnownPermission, PolicyArgs, PolicyDecision } from '@ultimat3/policy';
import { can, denied } from '@ultimat3/policy';
import type { JsonValue } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { McpApproversResolver } from './confirmation-approvers';
import { matchesApprover } from './confirmation-approvers';
import { decideConfirmation } from './confirmation-decide';
import { McpConfirmationToolUnknownError } from './confirmation-errors';
import type { McpConfirmationEvidence } from './confirmation-evidence';
import { confirmationToolGate } from './confirmation-gate';
import { installedConfirmationStore } from './confirmation-installed';
import { McpConfirmationQuorumInvalidError } from './confirmation-quorum-errors';
import type { McpConfirmation, McpConfirmationStore } from './confirmation-store';

/** Room for any detached signature encoding (Ed25519 base64url is 86); a megabyte vote is not one. */
const MAX_SIGNATURE_LENGTH = 4096;

/** Ten minutes: long enough for a person to read a request, short enough to go stale. */
export const DEFAULT_MCP_CONFIRMATION_TTL_MS = 600_000;

const decisionInput = () =>
  t.object({
    id: t.uuid,
    decision: t.enum(['view', 'approve', 'reject'] as const),
    /** What the person approves: the `arguments` `view` returned. Required to approve. */
    arguments: t.optional(t.record(t.json())),
    /** The approver's signature over `signingPayload`, under `evidence`. Bounded: it is stored. */
    signature: t.optional(t.string.max(MAX_SIGNATURE_LENGTH)),
  });

const decisionOutput = () =>
  t.object({
    id: t.string,
    tool: t.string,
    status: t.enum(['pending', 'approved', 'rejected'] as const),
    decidedAt: t.nullable(t.date),
    expiresAt: t.date,
    arguments: t.record(t.json()),
    quorum: t.number,
    approvedBy: t.array(t.string),
    signingPayload: t.string,
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
  /** The approver's signature over the `signingPayload` `view` returned, under `evidence`. */
  readonly signature?: string;
}

export interface McpConfirmationsInput<TTools extends string = string> {
  /**
   * The tools whose every call waits for a person, from `defineAppMcp({ confirmations })` AND from
   * `agent({ tools })`. Each must be one the server projects.
   */
  readonly tools: readonly TTools[];
  /**
   * Where pending rows live. Omitted: the `mcpConfirmationStore` port — what `runtime.ts`
   * installed, else Postgres over the app's pool. `memoryConfirmationStore()` for a test.
   */
  readonly store?: McpConfirmationStore | undefined;
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
  /**
   * N of M: per call, from its validated arguments, how many DISTINCT approvers matching `from`
   * must approve. Stored on the row when it opens. Declared, the requesting actor never counts (nor
   * an impersonated decider), and one approver counts once. Absent: one decision by anyone the
   * policy admits.
   */
  readonly approvers?: McpApproversResolver | undefined;
  /**
   * Signed decisions: every approval carries a signature over `signingPayload` (the row's id, tool
   * and keyed argument digest), checked by `verify` against keys registered to the approver at the
   * decision, stored with the vote, and re-checked from the stored row before the call runs.
   */
  readonly evidence?: McpConfirmationEvidence | undefined;
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
  readonly approvers: McpApproversResolver | undefined;
  readonly evidence: McpConfirmationEvidence | undefined;
}

/**
 * ```ts
 * // apps/web/app/orders/actions/confirm-refunds.ts
 * export const confirmRefunds = mcpConfirmations({
 *   tools: ['refundOrder'],
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
  const { check, approvers, evidence } = input;
  // Read per USE, never captured: `runtime.ts` may import this declaration before the boot installs
  // `runtime.mcpConfirmationStore`, and a captured default would keep rows in the wrong store.
  const storeOf = (): McpConfirmationStore => input.store ?? installedConfirmationStore();
  const sealKeys: SealKeySource = input.sealKeys ?? {};
  if (approvers !== undefined && typeof approvers !== 'function') {
    throw new McpConfirmationQuorumInvalidError({
      tool: input.tools.join(', '),
      reason: 'approvers is not a function of the call',
    });
  }
  if (evidence !== undefined && typeof evidence.verify !== 'function') {
    throw new McpConfirmationQuorumInvalidError({
      tool: input.tools.join(', '),
      reason: 'evidence declares no verify function, so no signature could ever be checked',
    });
  }

  const decide = action({
    input: decisionInput(),
    output: decisionOutput(),
    // The agent refusal is IN the policy, so it is decided by `guard()` — the one authz path — and
    // reads as the same `X_FORBIDDEN` on every surface. A confirmation an agent can grant is a
    // confirmation the agent that asked can grant.
    policy: can<McpConfirmationDecision, McpConfirmation>(input.permission, (args) => {
      if (args.actor?.kind === 'agent') return denied('mcp-confirmation.agent-decider');
      const standing = approverStanding(args);
      return standing ?? (check ?? sameTenant)(args);
    }),
    ...(input.audit === true ? { audit: true } : {}),
    row: async ({ input: asked }) => (await storeOf().get(asked.id)) ?? null,
    // The view and the decision: state only — the policy above has already decided who.
    handle: ({ input: asked, ctx }) =>
      decideConfirmation({ store: storeOf(), clock, sealKeys, evidence }, asked, ctx.actor.id),
  });
  const declared = Object.assign(decide, {
    tools: Object.freeze([...input.tools]),
    ttlMs,
    clock,
    sealKeys,
    approvers,
    evidence,
  });
  // A getter, so the gate (`confirmation-gate.ts`) asks the port at each call too.
  const confirmations: McpConfirmations<TTools> = Object.defineProperty(declared, 'store', {
    enumerable: true,
    get: storeOf,
  }) as typeof declared & { readonly store: McpConfirmationStore };
  // On the declaration, so there is no `agent({ confirmations })` for an author to forget. A worker
  // holds it only if it imports this module, which is `X_ROLE_LOAD_INCOMPLETE` when it would not.
  registerToolGate(confirmations.tools, confirmationToolGate(confirmations));
  return confirmations;
}

/**
 * A decision on a row opened under `approvers`: the requester never decides its own request, an
 * impersonated actor never stands in for the person it wears, and the decider must match one of the
 * row's stored selectors. `undefined` defers to `check`. `view` stays the policy's alone.
 */
function approverStanding(
  args: PolicyArgs<McpConfirmationDecision, McpConfirmation>,
): PolicyDecision | undefined {
  const { actor, row } = args;
  if (row === null || row.approvers === null || args.input.decision === 'view') return undefined;
  if (actor === null || actor.id === row.actorId) return denied('mcp-confirmation.requester');
  if (actor.onBehalfOf !== undefined) return denied('mcp-confirmation.impersonated');
  if (!matchesApprover(actor, row.approvers)) return denied('mcp-confirmation.not-an-approver');
  return undefined;
}

/**
 * The default `check`: the decider is in the asking agent's org, and a missing row is refused — so
 * "unknown id" and "another tenant's id" are one answer. An org-less agent's row is decided only by
 * an org-less person; anything wider is an explicit `check`.
 */
function sameTenant(args: PolicyArgs<unknown, McpConfirmation>): boolean {
  return args.row !== null && args.row.orgId === (args.actor?.orgId ?? null);
}
