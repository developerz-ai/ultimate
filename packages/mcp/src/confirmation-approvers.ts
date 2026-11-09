// `mcpConfirmations({ approvers })`: WHO may approve one gated call and HOW MANY of them must, resolved
// per call from its validated arguments, checked here before any row opens, and stored on the row so
// a later declaration change never moves the bar of a confirmation already asked. Matching a decider
// against the stored selectors is this file's too: the decision action's policy calls it.

import type { Actor } from '@ultimat3/core';
import { McpConfirmationQuorumInvalidError } from './confirmation-quorum-errors';

/**
 * One way to name an approver: `actor:<id>` (that actor exactly) or `role:<name>` (any actor holding
 * that application role). A closed template type, so `'finance'` is a compile error, not a selector
 * that silently matches nobody.
 */
export type McpApproverSelector = `actor:${string}` | `role:${string}`;

/** What `approvers({ args })` answers: `quorum` distinct approvers matching `from`, requester excluded. */
export interface McpConfirmationApprovers {
  readonly quorum: number;
  readonly from: readonly McpApproverSelector[];
}

/** The call `approvers` resolves over — the VALIDATED, defaulted arguments the digest binds. */
export interface McpApproversCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The asking actor. It never counts toward its own quorum, whatever `from` says. */
  readonly actor: Actor;
}

export type McpApproversResolver = (call: McpApproversCall) => McpConfirmationApprovers;

/** The bar one row is held to: `from: null` is "any decider the policy admits" (no `approvers`). */
export interface ResolvedApprovers {
  readonly quorum: number;
  readonly from: readonly string[] | null;
}

/** No `approvers` declared: one decision by anyone the policy admits — the original gate. */
export const SINGLE_APPROVAL: ResolvedApprovers = Object.freeze({ quorum: 1, from: null });

const SELECTOR = /^(actor|role):.+$/;

/**
 * Resolve and refuse: a quorum that is not a whole number of at least one, an empty or malformed
 * `from`, or more named actors than exist once the requester is excluded would hold the call until
 * it expires with nobody able to free it — a misdeclaration, so it is refused before a row opens.
 * A `role:` selector's membership is only known at decision time, so its reach is not checked here.
 */
export function resolveApprovers(
  resolver: McpApproversResolver | undefined,
  call: McpApproversCall,
): ResolvedApprovers {
  if (resolver === undefined) return SINGLE_APPROVAL;
  const { quorum, from } = resolver(call);
  const refuse = (reason: string) =>
    new McpConfirmationQuorumInvalidError({ tool: call.tool, reason });
  if (!Number.isSafeInteger(quorum) || quorum < 1) {
    throw refuse(`quorum is ${String(quorum)}, not a whole number of at least 1`);
  }
  if (from.length === 0) throw refuse('from is empty, so no actor could ever approve');
  const malformed = from.filter((selector) => !SELECTOR.test(selector));
  if (malformed.length > 0) {
    throw refuse(
      `from holds ${malformed.length} selector(s) that are not actor:<id> or role:<name>`,
    );
  }
  const named = new Set(from.filter((one) => one.startsWith('actor:')).map((one) => one.slice(6)));
  named.delete(call.actor.id);
  if (from.every((one) => one.startsWith('actor:')) && named.size < quorum) {
    throw refuse(
      `quorum ${quorum} needs more approvers than the ${named.size} named actor(s) other than the requester`,
    );
  }
  return Object.freeze({ quorum, from: Object.freeze([...new Set(from)]) });
}

/** Does `actor` match one of a row's stored selectors? `null` selectors admit every decider. */
export function matchesApprover(actor: Actor, from: readonly string[] | null): boolean {
  if (from === null) return true;
  return from.some((selector) =>
    selector.startsWith('actor:')
      ? selector.slice(6) === actor.id
      : selector.startsWith('role:') && actor.roles.includes(selector.slice(5)),
  );
}
