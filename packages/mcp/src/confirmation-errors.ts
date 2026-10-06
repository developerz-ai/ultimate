// The refusals of `mcpConfirmations`: the agent's call that waits for a human, the human's decision
// that came too late or twice, and the boot that gates a tool nobody projects. Split from
// `errors.ts` for its ceiling. Each `cause` names the confirmation id: it is the one fact both the
// agent relaying the request and the human deciding it need.

import { UltimateError } from '@ultimat3/core';

interface Subject {
  readonly id: string;
  readonly tool: string;
  readonly expiresAt: Date;
}

/** The instant, in UTC — an ISO string carries its own zone, so no reader has to guess one. */
const until = (subject: Subject): string => subject.expiresAt.toISOString();

const meta = (subject: Subject) => ({
  confirmation: subject.id,
  tool: subject.tool,
  expiresAt: until(subject),
});

/** The decision action, by the name it was registered under — or how to find it before then. */
const decider = (name: string): string =>
  name.length > 0 ? name : 'the mcpConfirmations() action';

/** The call did not run: a human has to approve this exact call first. */
export class McpConfirmationPendingError extends UltimateError {
  constructor(subject: Subject & { readonly decider: string }) {
    super({
      code: 'X_MCP_CONFIRMATION_PENDING',
      cause: `${subject.tool} needs a human's approval before it runs: confirmation ${subject.id} is pending until ${until(subject)}`,
      fix: `confirmations({ id, decision: 'view' })   # as a person, through ${decider(subject.decider)}, with id ${subject.id}; then confirmations({ id, decision: 'approve', arguments }) with exactly what view returned (or decision: 'reject'), and the agent repeats the same tools/call before ${until(subject)}`,
      callerFix: `ask a person who may approve it to view confirmation ${subject.id} and approve it with exactly the arguments it shows, then call ${subject.tool} again with exactly the same arguments before ${until(subject)}`,
      meta: meta(subject),
    });
  }
}

/** The confirmation lapsed — before the call came back for it, or before a human decided it. */
export class McpConfirmationExpiredError extends UltimateError {
  constructor(subject: Subject & { readonly at: 'call' | 'decision' }) {
    super({
      code: 'X_MCP_CONFIRMATION_EXPIRED',
      cause: `confirmation ${subject.id} for ${subject.tool} expired at ${until(subject)}${subject.at === 'call' ? '; the call did not run' : ' and can no longer be decided'}`,
      fix:
        subject.at === 'call'
          ? `{ method: 'tools/call', params: { name, arguments } }   # ${subject.tool} again with the same arguments opens a new confirmation; decide it before expiry, or raise mcpConfirmations({ ttlMs })`
          : `mcpConfirmations({ ttlMs })   # raise it if people need longer; ask the agent to call ${subject.tool} again, which opens a new confirmation`,
      meta: meta(subject),
    });
  }
}

/** A person rejected this exact call. Audited as a denial — a human saying no is one. */
export class McpConfirmationRejectedError extends UltimateError {
  constructor(subject: Subject) {
    super({
      code: 'X_MCP_CONFIRMATION_REJECTED',
      cause: `a person rejected confirmation ${subject.id}: ${subject.tool} did not run`,
      fix: `{ method: 'tools/call', params: { name, arguments } }   # ${subject.tool} with arguments changed after asking the person who rejected ${subject.id}; the same arguments are rejected again`,
      meta: meta(subject),
    });
  }
}

/** Approve or reject on a row already decided: a decision is taken once. */
export class McpConfirmationDecidedError extends UltimateError {
  constructor(subject: Subject & { readonly status: string }) {
    super({
      code: 'X_MCP_CONFIRMATION_DECIDED',
      cause: `confirmation ${subject.id} for ${subject.tool} was already ${subject.status}; a decision is taken once`,
      fix: `{ method: 'tools/call', params: { name, arguments } }   # ${subject.id} is final; the agent calling ${subject.tool} again opens a new confirmation to decide`,
      meta: { ...meta(subject), status: subject.status },
    });
  }
}

/** No confirmation has this id — mistyped, from another deployment, or purged after its expiry. */
export class McpConfirmationUnknownError extends UltimateError {
  constructor(id: string) {
    super({
      code: 'X_MCP_CONFIRMATION_UNKNOWN',
      cause: `no MCP confirmation has id ${id}`,
      fix: `confirmations({ id, decision: 'view' })   # with the id from the X_MCP_CONFIRMATION_PENDING answer the agent received; one past its expiry may be purged — ask the agent to call the tool again`,
      meta: { confirmation: id },
    });
  }
}

/** `mcpConfirmations({ tools })` names a tool this server does not project — or none at all. */
export class McpConfirmationToolUnknownError extends UltimateError {
  constructor(input: { readonly unknown: readonly string[]; readonly known: readonly string[] }) {
    const known = input.known.length === 0 ? '(none)' : input.known.join(', ');
    super({
      code: 'X_MCP_CONFIRMATION_TOOL_UNKNOWN',
      cause:
        input.unknown.length === 0
          ? 'mcpConfirmations({ tools: [] }) gates no tool, so every call it was meant to hold would run unconfirmed'
          : `mcpConfirmations({ tools }) names ${input.unknown.join(', ')}, which this MCP server does not project — that call would run unconfirmed`,
      fix: `mcpConfirmations({ tools: [...] })   # name tools this server projects: ${known}`,
      meta: { unknown: [...input.unknown], known: [...input.known] },
    });
  }
}

/** The store could not settle which row is open for a call, three times running. Retryable. */
export class McpConfirmationContestedError extends UltimateError {
  constructor(tool: string) {
    super({
      code: 'X_MCP_CONFIRMATION_CONTESTED',
      cause: `identical ${tool} calls from one agent kept opening and consuming its confirmation concurrently`,
      fix: `{ method: 'tools/call', params: { name, arguments } }   # retry ${tool} once the agent's concurrent identical calls finish — send one at a time`,
      meta: { tool },
    });
  }
}

/**
 * An approval that does not carry the arguments the agent sent: none, different ones (a swap
 * between the view and the decision), or a row keyed under a rotated signing secret.
 */
export class McpConfirmationArgumentsMismatchError extends UltimateError {
  constructor(subject: Subject & { readonly reason: 'missing' | 'different' | 'rotated' }) {
    const why = {
      missing: 'the approval carried no arguments',
      different: 'the approval carried arguments other than the ones the agent sent',
      rotated: 'the confirmation was keyed under a signing secret this process no longer holds',
    }[subject.reason];
    super({
      code: 'X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH',
      cause: `confirmation ${subject.id} for ${subject.tool} was not decided: ${why}`,
      fix: `confirmations({ id, decision: 'view' })   # for ${subject.id}, then confirmations({ id, decision: 'approve', arguments }) with exactly the arguments it returns; a rotated one: ask the agent to call ${subject.tool} again`,
      meta: { ...meta(subject), reason: subject.reason },
    });
  }
}
