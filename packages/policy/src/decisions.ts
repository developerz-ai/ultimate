// The authz decision log's one seam. Shaped exactly like core's `ErrorReporter`: always on, a
// no-op by default, the wire format supplied by a sink and never here. It exists because the
// question after an incident is "who did this, and which rule let them?" — and until now an
// allowed decision left no trace at all, on any of the four surfaces.
//
// PII rule, inherited and not negotiable: an event carries the label, the clause and the actor's
// identifiers. Never `row`, never `input`. `reason` is already safe to log by construction
// (policy/CLAUDE.md) and this is the guarantee that keeps it that way.
import { logger, renderThrowable } from '@ultimat3/core';
import type { Surface } from './surfaces';

export interface PolicyDecisionEvent {
  /** The policy's own label — `and(post:publish, org:administer)`. Safe to log. */
  readonly label: string;
  readonly allowed: boolean;
  /** `null` on an allow: there is no code for "yes". */
  readonly code: string | null;
  readonly reason: string | null;
  readonly actorId: string | null;
  readonly actorKind: string | null;
  readonly orgId: string | null;
  /** `null` when the evaluation did not come through a surface adapter. */
  readonly surface: Surface | null;
  /** The clause that decided, by label. `null` when the trace was off. */
  readonly deciding: string | null;
}

/** The driver seam. A SIEM exporter, an append-only table or a log line all arrive as one. */
export interface DecisionSink {
  record(event: PolicyDecisionEvent): void;
}

export const noopDecisionSink: DecisionSink = Object.freeze({
  record(): void {
    // Intentionally empty: an app that logs no decisions pays one property read per evaluation.
  },
});

let sink: DecisionSink | undefined;

export const setDecisionSink = (next: DecisionSink): void => {
  sink = next;
};

/** Test seam, and the only way back to "unconfigured" — which a literal cannot express. */
export const resetDecisionSink = (): void => {
  sink = undefined;
};

/**
 * Read by `evaluate()` before it builds an event, and by the trace default: a sink is the one
 * reason to keep building a trace in production.
 */
export const decisionSinkInstalled = (): boolean => sink !== undefined;

/**
 * Called from exactly ONE place — inside `evaluate()`, so a fifth surface inherits the log the
 * day it is added rather than the day someone remembers to wire it. Never throws: a sink that is
 * down must not turn an allowed request into a 500.
 */
export const emitDecision = (event: PolicyDecisionEvent): void => {
  if (sink === undefined) return;
  try {
    sink.record(event);
  } catch (failure) {
    logger.warn('policy decision sink failed', {
      label: event.label,
      error: renderThrowable(failure),
    });
  }
};

export interface MemoryDecisionSink extends DecisionSink {
  readonly events: readonly PolicyDecisionEvent[];
  reset(): void;
}

/** For tests, and for a `x dev` process that shows its own authz decisions without leaving the box. */
export const memoryDecisionSink = (): MemoryDecisionSink => {
  const events: PolicyDecisionEvent[] = [];
  return {
    events,
    record(event: PolicyDecisionEvent): void {
      events.push(event);
    },
    reset(): void {
      events.length = 0;
    },
  };
};
