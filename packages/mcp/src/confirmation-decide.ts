// The decision action's handle: `view` shows a person the request exactly as the agent sent it;
// `approve` / `reject` take a decision once per decider, an approval only for those same arguments
// and, under `evidence`, only with a signature that verifies. The policy already ran (agent and
// requester refusals, `approvers` selectors, tenant default), so this file decides STATE, never who.

import type { Clock, SealKeySource, UltimateError } from '@ultimat3/core';
import { compareFingerprint, openText } from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/schema';
import {
  McpConfirmationArgumentsMismatchError,
  McpConfirmationDecidedError,
  McpConfirmationExpiredError,
  McpConfirmationUnknownError,
} from './confirmation-errors';
import type { McpConfirmationEvidence } from './confirmation-evidence';
import { confirmationSigningPayload } from './confirmation-evidence';
import {
  MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
  MCP_CONFIRMATION_DIGEST_PURPOSE,
} from './confirmation-gate';
import {
  McpConfirmationEvidenceInvalidError,
  McpConfirmationQuorumPendingError,
} from './confirmation-quorum-errors';
import type { McpConfirmation, McpConfirmationStore } from './confirmation-store';

export interface DecisionAsked {
  readonly id: string;
  readonly decision: 'view' | 'approve' | 'reject';
  /** What the person approves — the `arguments` `view` returned. Required to approve. */
  readonly arguments?: Readonly<Record<string, JsonValue>> | undefined;
  /** The approver's signature over `signingPayload`. Required to approve under `evidence`. */
  readonly signature?: string | undefined;
}

export interface DecisionAnswer {
  readonly id: string;
  readonly tool: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  /** The arguments the agent sent, opened — what the person sees and what an approval binds to. */
  readonly arguments: Record<string, JsonValue>;
  /** Distinct approvals this confirmation needs, and who has given one so far, in order. */
  readonly quorum: number;
  readonly approvedBy: string[];
  /** What an approver signs under `evidence`: `confirmationSigningPayload(row)`. */
  readonly signingPayload: string;
}

export interface DecideDeps {
  readonly store: McpConfirmationStore;
  readonly clock: Clock;
  readonly sealKeys: SealKeySource;
  readonly evidence?: McpConfirmationEvidence | undefined;
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
  const approving = asked.decision === 'approve';
  let signature: string | null = null;
  if (approving) {
    assertSameArguments(row, asked.arguments);
    const repeated = repeatRefusal(row, deciderId);
    if (repeated !== undefined) throw repeated;
    signature = await signedBy(deps.evidence, row, deciderId, asked.signature);
  }
  const status = approving ? 'approved' : 'rejected';
  const decided = await deps.store.decide(row.id, status, deciderId, at, signature);
  // The CAS lost to a concurrent decision, the expiry, or this approver's own concurrent vote.
  if (decided === undefined) {
    const now = await deps.store.get(row.id);
    const why =
      now === undefined ? undefined : (stateRefusal(now, at) ?? repeatRefusal(now, deciderId));
    throw why ?? expired(row);
  }
  return answer(decided, shown);
}

/** An approver who already counted: a second vote is never a second approver. */
function repeatRefusal(row: McpConfirmation, deciderId: string): UltimateError | undefined {
  if (!row.approvals.some((vote) => vote.approver === deciderId)) return undefined;
  return new McpConfirmationQuorumPendingError({
    id: row.id,
    tool: row.tool,
    expiresAt: row.expiresAt,
    approvals: row.approvals.length,
    quorum: row.quorum,
    repeated: deciderId,
  });
}

/**
 * Under `evidence`, the vote's signature must verify over THIS row's signing payload under a key
 * registered to the decider — checked before any write, so a refused one stores no vote. A throw
 * from `verify` is an outage and propagates; only `true` admits.
 */
async function signedBy(
  evidence: McpConfirmationEvidence | undefined,
  row: McpConfirmation,
  approver: string,
  signature: string | undefined,
): Promise<string | null> {
  if (evidence === undefined) return null;
  const subject = { id: row.id, tool: row.tool, expiresAt: row.expiresAt };
  if (signature === undefined || signature.length === 0) {
    throw new McpConfirmationEvidenceInvalidError({ ...subject, reason: 'missing' });
  }
  const verified = await evidence.verify({
    approver,
    confirmation: row.id,
    tool: row.tool,
    digest: row.inputDigest,
    payload: confirmationSigningPayload(row),
    signature,
    from: row.approvers,
  });
  if (verified !== true) {
    throw new McpConfirmationEvidenceInvalidError({ ...subject, reason: 'refused' });
  }
  return signature;
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
  quorum: row.quorum,
  approvedBy: row.approvals.map((vote) => vote.approver),
  signingPayload: confirmationSigningPayload(row),
});
