// The decision action's handle: `view` shows a person the request exactly as the agent sent it;
// `approve` / `reject` take a decision once, and an approval only for those same arguments. The
// policy already ran (the factory's `can(…)`, agent refusal and tenant default included), so this
// file decides STATE, never who.

import type { Clock, SealKeySource, UltimateError } from '@ultimat3/core';
import { compareFingerprint, openText } from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/schema';
import {
  McpConfirmationArgumentsMismatchError,
  McpConfirmationDecidedError,
  McpConfirmationExpiredError,
  McpConfirmationUnknownError,
} from './confirmation-errors';
import {
  MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
  MCP_CONFIRMATION_DIGEST_PURPOSE,
} from './confirmation-gate';
import type { McpConfirmation, McpConfirmationStore } from './confirmation-store';

export interface DecisionAsked {
  readonly id: string;
  readonly decision: 'view' | 'approve' | 'reject';
  /** What the person approves — the `arguments` `view` returned. Required to approve. */
  readonly arguments?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface DecisionAnswer {
  readonly id: string;
  readonly tool: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  /** The arguments the agent sent, opened — what the person sees and what an approval binds to. */
  readonly arguments: Record<string, JsonValue>;
}

export interface DecideDeps {
  readonly store: McpConfirmationStore;
  readonly clock: Clock;
  readonly sealKeys: SealKeySource;
}

export async function decideConfirmation(
  deps: DecideDeps,
  asked: DecisionAsked,
  deciderId: string,
): Promise<DecisionAnswer> {
  const row = await deps.store.get(asked.id);
  if (row === undefined) throw new McpConfirmationUnknownError(asked.id);
  const shown = await openArguments(row, deps.sealKeys);
  if (asked.decision === 'view') return answer(row, shown);
  const at = deps.clock.now();
  const refused = stateRefusal(row, at);
  if (refused !== undefined) throw refused;
  if (asked.decision === 'approve') assertSameArguments(row, asked.arguments);
  const status = asked.decision === 'approve' ? 'approved' : 'rejected';
  const decided = await deps.store.decide(row.id, status, deciderId, at);
  // The CAS lost to a concurrent decision or the expiry: re-read and say which.
  if (decided === undefined) {
    const now = await deps.store.get(row.id);
    throw (now === undefined ? undefined : stateRefusal(now, at)) ?? expired(row);
  }
  return answer(decided, shown);
}

/**
 * The approval binds to what the person was SHOWN: the keyed digest of the arguments they send back
 * must match the row's, timing-safe (`compareFingerprint`). A swap between `view` and `approve` —
 * or an approval sent with no arguments at all — decides nothing. `unverifiable` is a rotated
 * signing secret: no approval, and the agent's next call opens a fresh confirmation anyway.
 */
function assertSameArguments(row: McpConfirmation, sent: DecisionAsked['arguments']): void {
  const subject = { id: row.id, tool: row.tool, expiresAt: row.expiresAt };
  if (sent === undefined) {
    throw new McpConfirmationArgumentsMismatchError({ ...subject, reason: 'missing' });
  }
  const verdict = compareFingerprint(row.inputDigest, sent, MCP_CONFIRMATION_DIGEST_PURPOSE);
  if (verdict === 'match') return;
  throw new McpConfirmationArgumentsMismatchError({
    ...subject,
    reason: verdict === 'unverifiable' ? 'rotated' : 'different',
  });
}

/** Why a row cannot be decided now: already decided, or past its expiry (or consumed as such). */
function stateRefusal(row: McpConfirmation, at: Date): UltimateError | undefined {
  if (row.status !== 'pending')
    return new McpConfirmationDecidedError({ ...row, status: row.status });
  if (row.consumedAt !== null || row.expiresAt.getTime() <= at.getTime()) return expired(row);
  return undefined;
}

const expired = (row: McpConfirmation): UltimateError =>
  new McpConfirmationExpiredError({ ...row, at: 'decision' });

async function openArguments(
  row: McpConfirmation,
  sealKeys: SealKeySource,
): Promise<Record<string, JsonValue>> {
  const text = await openText(row.sealedArguments, {
    purpose: MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
    ...sealKeys,
  });
  // Sealed by this package from a validated argument record, so the parse is of our own JSON.
  return JSON.parse(text) as Record<string, JsonValue>;
}

const answer = (row: McpConfirmation, shown: Record<string, JsonValue>): DecisionAnswer => ({
  id: row.id,
  tool: row.tool,
  status: row.status,
  expiresAt: row.expiresAt,
  decidedAt: row.decidedAt,
  arguments: shown,
});
