// Signed decisions for `mcpConfirmations({ evidence })`: the exact payload an approver signs, and the
// verifier over a STORED row that any process can run — the gate before it consumes an approval, or
// a separate executor that trusts nothing the app server wrote. Key lookup and signature maths are
// the app's (`evidence.verify`); this file owns what is signed and what a valid approval set is.

import { canonicalJson, compareFingerprint, finiteCount } from '@ultimat3/core';
import type { McpConfirmation } from './confirmation-store';

/** What one approver signs, by construction: never a value a caller assembles by hand. */
export const MCP_CONFIRMATION_SIGNING_PURPOSE = 'x-mcp-confirmation.approve/v1';

/** The keyed-digest purpose `inputDigest` uses; restated so this leaf imports no gate. */
const DIGEST_PURPOSE = 'mcp-confirmation';

/** What `evidence.verify` is asked about one signature. */
export interface McpEvidenceCheck {
  /** The approving actor's id — the one whose registered keys the signature must verify under. */
  readonly approver: string;
  readonly confirmation: string;
  readonly tool: string;
  /** The row's keyed argument digest (`h1:<key id>:<mac>`), bound into `payload`. */
  readonly digest: string;
  /** The exact string signed: `confirmationSigningPayload(row)`. Verify the signature over THIS. */
  readonly payload: string;
  readonly signature: string;
  /** The row's approver selectors, so a key registry can also confirm the approver's standing. */
  readonly from: readonly string[] | null;
}

export interface McpConfirmationEvidence {
  /**
   * `true` only when `signature` verifies over `payload` under a key registered to `approver`.
   * Anything else — `false`, a non-boolean — refuses. A throw propagates: an unreachable key store
   * is an outage, never a verdict, and the row is left as it was for a retry.
   */
  readonly verify: (check: McpEvidenceCheck) => boolean | Promise<boolean>;
}

/**
 * The payload an approver signs: purpose, confirmation id, tool and keyed digest, as canonical JSON.
 * The id makes a signature good for ONE row — replayed onto a later identical call it binds a
 * different id — and the digest makes it good for one set of arguments.
 */
export function confirmationSigningPayload(
  row: Pick<McpConfirmation, 'id' | 'tool' | 'inputDigest'>,
): string {
  return canonicalJson({
    purpose: MCP_CONFIRMATION_SIGNING_PURPOSE,
    confirmation: row.id,
    tool: row.tool,
    digest: row.inputDigest,
  });
}

export interface VerifyConfirmationOptions {
  /** Absent: signatures are not checked — only distinctness, eligibility and the quorum. */
  readonly evidence?: McpConfirmationEvidence | undefined;
  /** The bar the VERIFIER holds the row to; the row's own `quorum` is a floor it can only raise. */
  readonly quorum?: number | undefined;
  /** The verifier's selectors; defaults to the row's. Only `actor:` selectors are checked here. */
  readonly from?: readonly string[] | null | undefined;
  /** The arguments about to run: when given, the row's digest must be theirs (`compareFingerprint`). */
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
}

export type McpConfirmationVerdict =
  | { readonly ok: true; readonly approvers: readonly string[] }
  | { readonly ok: false; readonly reason: 'binding' | 'refused' | 'quorum' };

/**
 * Is this stored row a valid approval? Approved; bound to `arguments` when given; every stored
 * signature verifying (one forged vote fails the row — it is evidence the row was written around
 * the gate); and `quorum` distinct approvers counted, the requester never among them when selectors
 * were declared. Exported so the process that EXECUTES can re-check what the server stored.
 */
export async function verifyConfirmationEvidence(
  row: McpConfirmation,
  options: VerifyConfirmationOptions = {},
): Promise<McpConfirmationVerdict> {
  if (row.status !== 'approved') return { ok: false, reason: 'binding' };
  if (options.arguments !== undefined) {
    const bound = compareFingerprint(row.inputDigest, options.arguments, DIGEST_PURPOSE);
    if (bound !== 'match') return { ok: false, reason: 'binding' };
  }
  const from = options.from === undefined ? row.approvers : options.from;
  // A stored quorum that is not a number (a hand-edited row) makes `max` NaN, which no count meets.
  const floor = finiteCount('verifyConfirmationEvidence', 'quorum', options.quorum ?? 1, 1);
  const quorum = Math.max(row.quorum, floor);
  const payload = confirmationSigningPayload(row);
  const counted = new Set<string>();
  for (const vote of row.approvals) {
    if (options.evidence !== undefined) {
      if (vote.signature === null) return { ok: false, reason: 'refused' };
      const check = {
        approver: vote.approver,
        confirmation: row.id,
        tool: row.tool,
        digest: row.inputDigest,
        payload,
        signature: vote.signature,
        from,
      };
      if ((await options.evidence.verify(check)) !== true) return { ok: false, reason: 'refused' };
    }
    if (eligible(vote.approver, row.actorId, from)) counted.add(vote.approver);
  }
  return counted.size >= quorum
    ? { ok: true, approvers: [...counted] }
    : { ok: false, reason: 'quorum' };
}

/** Countable here: not the requester under selectors, and named when every selector is an actor. */
function eligible(approver: string, requester: string, from: readonly string[] | null): boolean {
  if (from === null) return true;
  if (approver === requester) return false;
  if (!from.every((one) => one.startsWith('actor:'))) return true;
  return from.includes(`actor:${approver}`);
}
