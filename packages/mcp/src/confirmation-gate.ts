// The agent's side of `mcpConfirmations`: a gated tool's `handle`, wrapped, so the order is
// visibility → scope → args → admit → confirmation → policy (a projected action's full policy runs
// in `handle`), and a caller the tool refuses outright never opens a row. An in-app agent meets the
// same body through `confirmationToolGate`, read by `@ultimat3/ai`'s adapter.

import type { ToolGate } from '@ultimat3/action';
import { toolGateFor } from '@ultimat3/action';
import type { Actor, UltimateError } from '@ultimat3/core';
import { keyedFingerprint, seal, uuidV7 } from '@ultimat3/core';
import { outstandingApprovers, resolveApprovers } from './confirmation-approvers';
import {
  McpConfirmationContestedError,
  McpConfirmationExpiredError,
  McpConfirmationPendingError,
  McpConfirmationRejectedError,
  McpConfirmationToolUnknownError,
} from './confirmation-errors';
import { verifyConfirmationEvidence } from './confirmation-evidence';
import {
  McpConfirmationEvidenceInvalidError,
  McpConfirmationQuorumPendingError,
} from './confirmation-quorum-errors';
import type { McpConfirmation } from './confirmation-store';
import type { McpConfirmations } from './confirmations';
import type { AnyMcpTool, McpCaller, McpToolResult, ToolArgs } from './registry';
import { invalidArgsError } from './server-voice';
import { validateArgs } from './validate-args';

/**
 * The gated catalog. The server's own `confirmations` wins for the names it gates, and refuses at
 * boot a name the catalog does not hold — that call would run with no person ever asked, which is
 * exactly the silent pass the gate exists to remove. Every other tool asks the registered gate at
 * call time: `mcpConfirmations({ tools })` says every call waits, so forgetting this option is no way
 * around it, and the module declaring the gate may evaluate after this server.
 */
export function withConfirmations(
  tools: readonly AnyMcpTool[],
  confirmations: McpConfirmations | undefined,
): readonly AnyMcpTool[] {
  const own = confirmations?.tools ?? [];
  const known = tools.map((tool) => tool.name);
  const unknown = own.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new McpConfirmationToolUnknownError({ unknown, known });
  return tools.map((tool) =>
    confirmations !== undefined && own.includes(tool.name)
      ? gate(tool, confirmations)
      : registeredGate(tool),
  );
}

/** `tool`, asking the gate registered for its name per call. Same order as `gate` below. */
function registeredGate(tool: AnyMcpTool): AnyMcpTool {
  return {
    ...tool,
    // The catalog's label reads what is declared by now; the refusal below reads the call's truth.
    ...(toolGateFor(tool.name) === undefined ? {} : { confirms: true }),
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      const toolGate = toolGateFor(tool.name);
      if (toolGate === undefined) return tool.handle(args, caller);
      tool.admit?.(caller);
      const call = {
        tool: tool.name,
        args,
        inputSchema: tool.inputSchema,
        actor: caller.actor,
      };
      // What a gate answers is what `run` answered, or it threw: this `run` answers a tool result.
      return (await toolGate(call, async () => tool.handle(args, caller))) as McpToolResult;
    },
  };
}

/** What the arguments are sealed FOR — bound into the AES-GCM tag, so they open as nothing else. */
export const MCP_CONFIRMATION_ARGUMENTS_PURPOSE = 'mcp-confirmation.arguments';

/** Separates this use of the signing secret from every other keyed fingerprint. */
export const MCP_CONFIRMATION_DIGEST_PURPOSE = 'mcp-confirmation';

/**
 * The digest an approval binds to: core's `keyedFingerprint` over the VALIDATED arguments (defaults
 * applied, the reserved `idempotencyKey` included) — HMAC-SHA-256 under a key derived from the
 * app's signing secret, 128 bits, `h1:<key id>:<mac>`. Keyed, never a plain hash, because the row
 * PERSISTS it: an unkeyed digest of `{ accountNumber }` is brute-forced from a database read. And it
 * binds: a second input sharing an approved digest needs the key.
 *
 * The store finds the open row by EQUALITY on this string, so the key id is part of the lookup:
 * after a secret rotation the same call computes a different value, matches no row, and opens a
 * FRESH confirmation — never a mismatch error, never the old approval. Rows under the old key are
 * orphaned until `purge`. Equality, not `compareFingerprint`: the caller cannot compute the value,
 * so the lookup's timing says nothing, and `unverifiable` could only describe a row this call
 * never finds.
 */
export function inputDigest(args: ToolArgs): string {
  return keyedFingerprint(args, MCP_CONFIRMATION_DIGEST_PURPOSE);
}

function gate(tool: AnyMcpTool, confirmations: McpConfirmations): AnyMcpTool {
  return {
    ...tool,
    confirms: true,
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      // Caller-only half of the policy first: one who may never call this opens no row for a person
      // to look at. Throws the same denial `handle` would, rendered by the server.
      tool.admit?.(caller);
      return confirmedCall(
        confirmations,
        { tool: tool.name, args, actor: caller.actor },
        async () => tool.handle(args, caller),
      );
    },
  };
}

/**
 * The gate a tool meets outside any MCP server: `@ultimat3/ai`'s adapter runs it for an in-app agent.
 * The arguments are checked here because no registry did, so the digest is over the same validated,
 * defaulted arguments the MCP path digests, and a repeat spelling a default differently consumes the
 * approval. A failure REFUSES and never calls `run`: the action's own parse drops a key it does not
 * declare, so handing it `{ orderId, invented: 1 }` would run the tool with nobody asked. No schema
 * declared: whatever object was sent is what a person is shown and what the digest binds.
 */
export function confirmationToolGate(confirmations: McpConfirmations): ToolGate {
  return async ({ tool, args, inputSchema, actor }, run) => {
    const checked = validateArgs(inputSchema ?? { type: 'object' }, args);
    if (!checked.ok) throw invalidArgsError(tool, checked.issues);
    return confirmedCall(confirmations, { tool, args: checked.value, actor }, run);
  };
}

/** One gated call: asks a person, or takes the decided outcome, and runs `proceed` on an approval. */
async function confirmedCall<T>(
  confirmations: McpConfirmations,
  call: { readonly tool: string; readonly args: ToolArgs; readonly actor: Actor },
  proceed: () => Promise<T>,
): Promise<T> {
  const { store, clock, ttlMs, sealKeys } = confirmations;
  const { tool, args, actor } = call;
  const now = clock.now();
  // Resolved from the validated arguments before any row opens: a bar nobody can meet is refused
  // here, and the one met is stored on the row so a later declaration cannot lower it.
  const bar = resolveApprovers(confirmations.approvers, { tool, args, actor });
  const draft = {
    id: uuidV7(clock),
    actorId: actor.id,
    orgId: actor.orgId ?? null,
    tool,
    inputDigest: inputDigest(args),
    // Sealed, never plaintext at rest: the person deciding reads them through the decision
    // action's `view`, and approves only by sending them back (`confirmation-decide.ts`).
    sealedArguments: await seal(JSON.stringify(args), {
      purpose: MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
      ...sealKeys,
    }),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    quorum: bar.quorum,
    approvers: bar.from,
  };
  // Bounded: `consume` loses only to a concurrent identical call by the same agent, which then
  // carries the outcome; this one opens the next row on the following pass.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { row, created } = await store.open(draft);
    const subject = { id: row.id, tool, expiresAt: row.expiresAt };
    // Before any outcome is taken: a row of another org is not this call's to wait on, run or
    // consume — the actor id alone would carry one org's approval into another's call.
    if (row.orgId !== draft.orgId) {
      throw new McpConfirmationEvidenceInvalidError({ ...subject, reason: 'org' });
    }
    const live = row.expiresAt.getTime() > now.getTime();
    if (created || (row.status === 'pending' && live)) throw waiting(row, confirmations.name);
    if (row.status === 'approved' && live) {
      // Re-verified from what is STORED, before the CAS: a row written around the decision action
      // runs nothing, and a verifier that throws leaves the approval in place for a retry.
      const verdict = await verifyConfirmationEvidence(row, {
        evidence: confirmations.evidence,
        quorum: bar.quorum,
        from: bar.from,
        arguments: args,
      });
      if (!verdict.ok) {
        if (!(await store.consume(row.id, now))) continue;
        throw new McpConfirmationEvidenceInvalidError({ ...subject, reason: verdict.reason });
      }
    }
    // Every other state is an OUTCOME, delivered once: taking it is what frees this call to
    // ask again, and what makes one approval run one call.
    if (!(await store.consume(row.id, now))) continue;
    if (row.status === 'rejected') throw new McpConfirmationRejectedError(subject);
    if (!live) throw new McpConfirmationExpiredError({ ...subject, at: 'call' });
    return proceed();
  }
  throw new McpConfirmationContestedError(tool);
}

/** Pending with no vote yet asks a person; pending with some asks for the rest of the quorum. */
function waiting(row: McpConfirmation, decider: string): UltimateError {
  const subject = { id: row.id, tool: row.tool, expiresAt: row.expiresAt };
  if (row.approvals.length === 0) return new McpConfirmationPendingError({ ...subject, decider });
  return new McpConfirmationQuorumPendingError({
    ...subject,
    approvals: row.approvals.length,
    quorum: row.quorum,
    outstanding: outstandingApprovers(
      row.approvers,
      row.approvals.map((vote) => vote.approver),
      row.actorId,
    ),
  });
}
