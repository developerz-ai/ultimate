// The refusals the quorum and signed-evidence half of `mcpConfirmations` adds: a call that has some
// approvals and needs more, an approval (or a stored row) whose signed evidence does not verify, and
// an `approvers` declaration no approver set could ever meet. Split from `confirmation-errors.ts`
// for its ceiling; each `cause` names the confirmation id, the one fact every reader needs.

import { UltimateError } from '@ultimat3/core';

interface Subject {
  readonly id: string;
  readonly tool: string;
  readonly expiresAt: Date;
}

const until = (subject: Subject): string => subject.expiresAt.toISOString();

/** Some distinct approvers have approved; the quorum the row was opened with is not yet met. */
export class McpConfirmationQuorumPendingError extends UltimateError {
  constructor(
    subject: Subject & {
      readonly approvals: number;
      readonly quorum: number;
      /** Set when THIS approver had already counted: a second vote is never a second approver. */
      readonly repeated?: string | undefined;
    },
  ) {
    const already =
      subject.repeated === undefined
        ? ''
        : `; ${subject.repeated} has already approved it, and one approver counts once`;
    super({
      code: 'X_MCP_CONFIRMATION_QUORUM_PENDING',
      cause: `confirmation ${subject.id} for ${subject.tool} has ${subject.approvals} of the ${subject.quorum} distinct approvals it needs${already}; it stays open until ${until(subject)}`,
      fix: `confirmations({ id, decision: 'view' })   # as ANOTHER approver the quorum names, with id ${subject.id}; then confirmations({ id, decision: 'approve', arguments }) with exactly what view returned, and the agent repeats the same tools/call before ${until(subject)}`,
      callerFix: `ask ${subject.quorum - subject.approvals} more person(s) who may approve it to view confirmation ${subject.id} and approve it, then call ${subject.tool} again with exactly the same arguments before ${until(subject)}`,
      meta: {
        confirmation: subject.id,
        tool: subject.tool,
        expiresAt: until(subject),
        approvals: subject.approvals,
        quorum: subject.quorum,
      },
    });
  }
}

/** Why evidence did not verify — a closed list, so a reader can branch on `meta.reason`. */
export type McpEvidenceFailure =
  /** An approval was sent with no signature while `evidence` is declared. */
  | 'missing'
  /** `evidence.verify` answered anything but `true` for the signature sent or stored. */
  | 'refused'
  /** The stored row's distinct, eligible, verified approvals fall short of the quorum. */
  | 'quorum'
  /** The row is not approved, or the arguments presented are not the ones its digest binds. */
  | 'binding'
  /** The store answered a row opened in another org than the calling actor's. */
  | 'org';

const WHY: Readonly<Record<McpEvidenceFailure, string>> = {
  missing: 'the approval carried no signature, and mcpConfirmations({ evidence }) requires one',
  refused:
    "a signature did not verify against the keys registered to its approver over this confirmation's signing payload",
  quorum:
    'its stored approvals are fewer distinct, eligible approvers than its quorum — the row was altered after the decision',
  binding:
    'the stored row is not an approval of these arguments — it was altered after the decision',
  org: "the store answered a row opened in another org than the caller's, and an org's approval never runs a call in another",
};

/** Signed evidence failed: at the decision (no vote stored) or at the call (nothing ran). */
export class McpConfirmationEvidenceInvalidError extends UltimateError {
  constructor(subject: Subject & { readonly reason: McpEvidenceFailure }) {
    super({
      code: 'X_MCP_CONFIRMATION_EVIDENCE_INVALID',
      cause: `confirmation ${subject.id} for ${subject.tool} was not accepted: ${WHY[subject.reason]}`,
      fix:
        subject.reason === 'missing' || subject.reason === 'refused'
          ? `confirmations({ id, decision: 'view' })   # for ${subject.id}; sign the signingPayload it returns with a key registered to you, then confirmations({ id, decision: 'approve', arguments, signature })`
          : subject.reason === 'org'
            ? `mcpConfirmations({ store: postgresConfirmationStore({ executor }) })   # or memoryConfirmationStore(); a custom store's open() must key the open row by orgId too — audit who wrote x_mcp_confirmations ${subject.id}`
            : `{ method: 'tools/call', params: { name, arguments } }   # ${subject.tool} again opens a new confirmation; audit who wrote to x_mcp_confirmations for ${subject.id}`,
      meta: {
        confirmation: subject.id,
        tool: subject.tool,
        expiresAt: until(subject),
        reason: subject.reason,
      },
    });
  }
}

/** `approvers({ args })` answered a bar no approver set can meet. Refused before a row opens. */
export class McpConfirmationQuorumInvalidError extends UltimateError {
  constructor(input: { readonly tool: string; readonly reason: string }) {
    super({
      code: 'X_MCP_CONFIRMATION_QUORUM_INVALID',
      cause: `mcpConfirmations({ approvers }) for ${input.tool}: ${input.reason}; the call would wait until it expired with nobody able to approve it`,
      fix: `mcpConfirmations({ approvers: ({ args }) => ({ quorum: 1, from: ['role:<name>'] }) })   # a whole quorum of at least 1, over 'role:<name>' or 'actor:<id>' selectors that reach it without the asking actor`,
      meta: { tool: input.tool },
    });
  }
}
