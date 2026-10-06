// The agent's side of `mcpConfirmations`: a gated tool's `handle`, wrapped. It runs AFTER the
// registry's visibility → scope → args and the tool's caller-only `admit`, and BEFORE the tool's own
// `handle` — where a projected action's full policy runs. So the order is visibility → scope →
// args → admit → confirmation → policy, and a caller the tool refuses outright never opens a row.

import { keyedFingerprint, seal, uuid } from '@ultimat3/core';
import {
  McpConfirmationContestedError,
  McpConfirmationExpiredError,
  McpConfirmationPendingError,
  McpConfirmationRejectedError,
  McpConfirmationToolUnknownError,
} from './confirmation-errors';
import type { McpConfirmations } from './confirmations';
import type { AnyMcpTool, McpCaller, McpToolResult, ToolArgs } from './registry';

/**
 * The gated catalog. Refuses at boot a name the catalog does not hold — that call would run with
 * no person ever asked, which is exactly the silent pass the gate exists to remove.
 */
export function withConfirmations(
  tools: readonly AnyMcpTool[],
  confirmations: McpConfirmations | undefined,
): readonly AnyMcpTool[] {
  if (confirmations === undefined) return tools;
  const known = tools.map((tool) => tool.name);
  const unknown = confirmations.tools.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new McpConfirmationToolUnknownError({ unknown, known });
  const gated = new Set(confirmations.tools);
  return tools.map((tool) => (gated.has(tool.name) ? gate(tool, confirmations) : tool));
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
  const { store, clock, ttlMs, sealKeys } = confirmations;
  return {
    ...tool,
    confirms: true,
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      // Caller-only half of the policy first: one who may never call this opens no row for a person
      // to look at. Throws the same denial `handle` would, rendered by the server.
      tool.admit?.(caller);
      const now = clock.now();
      const draft = {
        id: uuid(clock),
        actorId: caller.actor.id,
        orgId: caller.actor.orgId ?? null,
        tool: tool.name,
        inputDigest: inputDigest(args),
        // Sealed, never plaintext at rest: the person deciding reads them through the decision
        // action's `view`, and approves only by sending them back (`confirmation-decide.ts`).
        sealedArguments: await seal(JSON.stringify(args), {
          purpose: MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
          ...sealKeys,
        }),
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      };
      // Bounded: `consume` loses only to a concurrent identical call by the same agent, which then
      // carries the outcome; this one opens the next row on the following pass.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { row, created } = await store.open(draft);
        const subject = { id: row.id, tool: tool.name, expiresAt: row.expiresAt };
        const live = row.expiresAt.getTime() > now.getTime();
        if (created || (row.status === 'pending' && live)) {
          throw new McpConfirmationPendingError({ ...subject, decider: confirmations.name });
        }
        // Every other state is an OUTCOME, delivered once: taking it is what frees this call to
        // ask again, and what makes one approval run one call.
        if (!(await store.consume(row.id, now))) continue;
        if (row.status === 'rejected') throw new McpConfirmationRejectedError(subject);
        if (!live) throw new McpConfirmationExpiredError({ ...subject, at: 'call' });
        return tool.handle(args, caller);
      }
      throw new McpConfirmationContestedError(tool.name);
    },
  };
}
