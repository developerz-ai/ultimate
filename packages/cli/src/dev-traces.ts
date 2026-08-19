// The `/_x` timeline panel's source: core's own spans, recorded in this process. `x dev` installs
// the exporter at boot, so every `withSpan` the framework already opens — the request, the action,
// the query, the cache bust — arrives here and is assembled back into the tree the flame draws.
// A tracer written here instead would be a second one, disagreeing with `x trace` by construction.

import type { RequestTrace, SpanKind, TimelineSpan } from '@ultimat3/admin/dev';
import type { ReadableSpan, SpanExporter } from '@ultimat3/core';
// The attribute name is `@ultimat3/db`'s to declare — this reads it rather than restating it, so
// renaming it there is a compile error here instead of a panel that silently groups nothing.
import { STATEMENT_ATTRIBUTE } from '@ultimat3/db';

/** Traces retained. A dev panel shows recent requests; it does not page through history. */
const DEFAULT_LIMIT = 50;

export interface TraceRecorder {
  /** Hand this to `configureTelemetry({ exporter })`. */
  readonly exporter: SpanExporter;
  /** Complete request traces, newest first. */
  traces(): readonly RequestTrace[];
  reset(): void;
}

/**
 * Span name → the vocabulary the panel renders. The framework's span names are prefixed by the
 * subsystem that opened them (`action.publishPost`, `query.feed`, `cache.invalidate`), so the
 * prefix IS the kind — no registry of names to keep in step with the packages that emit them.
 */
const KIND_BY_PREFIX: readonly (readonly [string, SpanKind])[] = [
  // Two producers of `sql`, one axis: `db.` is the statement itself (`db.select`, carrying its
  // text), `query.` is the read that compiled it. The panel counts repeats of the detail, so a
  // repository loop shows up as one SQL text fifty times and not as one `query.feed`.
  ['db.', 'sql'],
  ['query.', 'sql'],
  ['cache.', 'cache'],
  ['action.', 'action'],
  ['policy.', 'policy'],
  ['job.', 'job'],
  ['render.', 'render'],
];

function kindOf(name: string, isRoot: boolean): SpanKind {
  if (isRoot) return 'http';
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (name.startsWith(prefix)) return kind;
  }
  // Everything the framework opens carries a prefix; anything else came from app code, which is
  // work the request did — filed under `action` rather than dropped from the flame it happened in.
  return 'action';
}

const attrString = (span: ReadableSpan, key: string): string | undefined => {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
};

const attrNumber = (span: ReadableSpan, key: string): number | undefined => {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
};

/**
 * The pipeline names its root span `<METHOD> <path>` and tags it with `http.*`. Reading the
 * attributes first and the name only as a fallback keeps the panel working against a root span
 * from any host, while still preferring the facts the pipeline states outright.
 */
function requestFacts(root: ReadableSpan): { method: string; path: string } {
  const [namedMethod = '', namedPath = ''] = root.name.split(' ');
  return {
    method: attrString(root, 'http.method') ?? namedMethod,
    path: attrString(root, 'http.route') ?? namedPath,
  };
}

/** `http.request_id` is stamped by the pipeline's root and by nothing else; the name is a fallback. */
const isHttpRoot = (span: ReadableSpan): boolean =>
  span.attributes['http.request_id'] !== undefined || /^[A-Z]+ \//.test(span.name);

/**
 * The request's own span among a trace's. `parentSpanId === undefined` was a third CONDITION
 * until `As of 2026-08`, and it dropped every request that arrived with an inbound
 * `traceparent`: `pipeline.ts` passes `parent: correlation.parent`, so the root has a defined
 * `parentSpanId`, `spans.find(isHttpRoot)` answered `undefined`, and the whole trace vanished
 * from `/_x/timeline` for any caller behind an instrumented client, an ingress or a service
 * mesh. It survives as the TIE-BREAK: the outermost candidate is the one whose parent is not
 * itself in this recording, so a nested candidate can never outrank the request's own span.
 */
function httpRootOf(spans: readonly ReadableSpan[]): ReadableSpan | undefined {
  const candidates = spans.filter(isHttpRoot);
  const recorded = new Set(spans.map((span) => span.context.spanId));
  const outermost = candidates.find(
    (span) => span.parentSpanId === undefined || !recorded.has(span.parentSpanId),
  );
  return outermost ?? candidates[0];
}

function toTrace(root: ReadableSpan, spans: readonly ReadableSpan[]): RequestTrace {
  const { method, path } = requestFacts(root);
  const origin = root.startedAt;
  return {
    requestId: attrString(root, 'http.request_id') ?? root.context.traceId,
    method,
    path,
    status: attrNumber(root, 'http.status_code') ?? 0,
    startedAt: new Date(origin).toISOString(),
    totalMs: root.durationMs,
    spans: spans
      .map(
        (span): TimelineSpan => ({
          id: span.context.spanId,
          // The root anchors the flame at depth 0, so its parent is null even though the span
          // itself may have arrived with a parent from an inbound `traceparent`.
          parentId: span === root ? null : (span.parentSpanId ?? null),
          kind: kindOf(span.name, span === root),
          name: span.name,
          startMs: Math.max(0, span.startedAt - origin),
          durationMs: span.durationMs,
          // The panel counts repeats of `detail` to find the N+1. A statement states its own
          // identity (`STATEMENT_ATTRIBUTE`, set by `@ultimat3/db`'s funnels); for every other span
          // the name is that identity — `query.feed` twice is two reads of one query.
          detail: attrString(span, STATEMENT_ATTRIBUTE) ?? span.name,
        }),
      )
      .sort((a, b) => a.startMs - b.startMs),
  };
}

/**
 * Spans end innermost-first, so a trace is only whole once its root arrives — which is also the
 * moment the request finished. Grouping by trace id and reporting only groups that have an HTTP
 * root is what keeps a half-finished request, and a job's spans, out of a panel about requests.
 */
export function createTraceRecorder(options: { limit?: number } = {}): TraceRecorder {
  const limit = options.limit ?? DEFAULT_LIMIT;
  // Insertion-ordered: the oldest trace id is the first key, which is the one eviction drops.
  const byTrace = new Map<string, ReadableSpan[]>();

  const record = (span: ReadableSpan): void => {
    const traceId = span.context.traceId;
    const spans = byTrace.get(traceId);
    if (spans === undefined) {
      byTrace.set(traceId, [span]);
      // Bounded by TRACE, not by span: dropping half a request would leave a flame with holes.
      // The cost is stated rather than capped — one trace's span array has no bound of its own, so
      // a request issuing 50k statements holds 50k `ReadableSpan`s until it is evicted. That is a
      // dev-only recorder (`serve.ts` installs none), and a per-trace cap would silently produce
      // the holed flame this bound exists to prevent.
      while (byTrace.size > limit) {
        const oldest = byTrace.keys().next();
        if (oldest.done === true) break;
        byTrace.delete(oldest.value);
      }
      return;
    }
    spans.push(span);
  };

  return {
    exporter: { export: record },
    traces(): readonly RequestTrace[] {
      const traces: RequestTrace[] = [];
      for (const spans of byTrace.values()) {
        const root = httpRootOf(spans);
        if (root !== undefined) traces.push(toTrace(root, spans));
      }
      return traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
    reset(): void {
      byTrace.clear();
    },
  };
}
