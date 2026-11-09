// The authz decision log: every evaluation, allowed ones included, is a `policy.decision` event on
// the instrumentation bus — because the question after an incident is "who did this, and which
// rule let them?", and an allowed decision used to leave no trace on any of the four surfaces.
// A SIEM exporter, an append-only table or a log line all arrive as one `subscribe()`.
//
// PII rule, inherited and not negotiable: an event carries the label, the clause and the actor's
// identifiers. Never `row`, never `input`. `reason` is already safe to log by construction
// (policy/CLAUDE.md) and this is the guarantee that keeps it that way.
import { instrument, type PolicyDecisionEvent, subscribed } from '@ultimat3/core';

const DECISION = 'policy.decision';

/**
 * Read by `evaluate()` before it builds an event, and by the trace default: a subscriber is the
 * one reason to keep building a trace in production. One map read when nobody listens.
 */
export const decisionObserved = (): boolean => subscribed(DECISION);

/**
 * Called from exactly ONE place — inside `evaluate()`, so a fifth surface inherits the log the day
 * it is added rather than the day someone remembers to wire it. A throwing subscriber is contained
 * by the bus, as on every event: an observer is not an authorization input and cannot deny.
 */
export const emitDecision = (event: PolicyDecisionEvent): void => {
  instrument(DECISION, event);
};
