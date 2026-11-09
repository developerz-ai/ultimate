// Single responsibility: the framework's instrumentation vocabulary — every event name the bus
// carries, the payload each one delivers, and the span kind its emitter opens. Payloads are
// declared HERE, structurally, because core is tier 0: the emitting package re-exports the type,
// it never owns a second shape. An app adds its own names by augmenting `InstrumentEventMap`.

import type { LogLevel } from './logger';
import type { ReadableSpan, SpanKind } from './telemetry';

/** What every timed event carries: wall time from start to settle, and the failure, if any. */
export interface TimedEvent {
  readonly durationMs: number;
  /** What the work threw, as the caller is about to receive it. Absent on success. */
  readonly error?: unknown;
}

export interface HttpRequestEvent extends TimedEvent {
  readonly method: string;
  /** The matched route PATTERN (`/r/:token`), never the URL — `undefined` when nothing matched. */
  readonly route: string | undefined;
  readonly status: number;
}

/** Who compiled a statement — `@ultimat3/entity` knows it, hand-written SQL does not. */
export interface StatementAttribution {
  readonly entity: string;
  readonly op: string;
}

export interface DbStatementEvent extends TimedEvent {
  /** Parameterised (`$1..$n`) — safe to log. */
  readonly text: string;
  /** Bound values, in order. May carry user data: a subscriber that logs them must redact. */
  readonly values: readonly unknown[];
  /** Rows returned or affected; `0` when the statement threw. */
  readonly rows: number;
  readonly attribution?: StatementAttribution | undefined;
  /** The innermost `expectedQueryLoop()` reason this statement ran inside. */
  readonly expected?: string | undefined;
  /**
   * The stack the statement was SENT from, captured before the driver's first `await` — present
   * only while a holder has `captureStatementStacks()` on (the `statements` test fixture); never in
   * production, where a stack per statement is cost nobody reads.
   */
  readonly callerStack?: string | undefined;
}

export type EntityRowOp = 'insert' | 'update' | 'delete';

export interface EntityRowEvent {
  /** Entity name as declared, never a table name. */
  readonly entity: string;
  readonly op: EntityRowOp;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  /** `currentWriteOrigin()` at the write — the digest of the request's idempotency key. */
  readonly write?: string | undefined;
}

export interface EntityBulkEvent {
  readonly entity: string;
  readonly op: 'delete' | 'update';
  readonly rows: number;
}

export interface EntityCrossTenantEvent {
  readonly reason: string;
}

export interface PolicyDecisionEvent {
  readonly label: string;
  readonly allowed: boolean;
  readonly code: string | null;
  readonly reason: string | null;
  readonly actorId: string | null;
  readonly actorKind: string | null;
  readonly orgId: string | null;
  readonly surface: string | null;
  readonly deciding: string | null;
}

export interface ActionInvokeEvent extends TimedEvent {
  readonly action: string;
}

export interface QueryReadEvent extends TimedEvent {
  readonly query: string;
}

export interface JobEnqueueEvent {
  readonly job: string;
  readonly queue: string;
  readonly id: string;
}

export interface JobPerformEvent extends TimedEvent {
  readonly job: string;
  readonly queue: string;
  readonly id: string;
  /** 1-based. */
  readonly attempt: number;
}

export interface AiLlmEvent extends TimedEvent {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHit: boolean;
}

export interface RenderPageEvent extends TimedEvent {
  readonly route: string;
}

export interface RenderIsrRegenerateEvent extends TimedEvent {
  readonly route: string;
  readonly path: string;
}

export interface RenderHoleEvent extends TimedEvent {
  readonly route: string;
  readonly hole: string;
}

export interface OutboundRequestEvent extends TimedEvent {
  /** The bounded label the call was made with (`'resend'`). */
  readonly vendor: string;
  readonly method: string;
  readonly host: string;
  /** The last answer's status; absent when no answer arrived. */
  readonly status?: number | undefined;
}

export interface MailDeliverEvent extends TimedEvent {
  readonly transport: string;
  /** A count — addresses are personal data and never ride an event. */
  readonly recipients: number;
}

export interface StorageEvent extends TimedEvent {
  readonly disk: string;
  readonly key: string;
  readonly bytes?: number | undefined;
}

export interface CacheLookupEvent {
  readonly tier: string;
  readonly key: string;
}

export interface CacheInvalidateEvent extends TimedEvent {
  readonly tags: readonly string[];
  /**
   * What triggered the bust: the name of the span active when `invalidateTags` was called, else
   * `'invalidateTags'`. Read at the call, because a subscriber runs after that span has moved on.
   */
  readonly source?: string | undefined;
  /** Everything the fan-out actually cleared: tier keys, ISR paths, live queries. */
  readonly busted: readonly string[];
  /** Tier failures, verbatim — a partial bust must not read as a clean one. */
  readonly errors: readonly { readonly tier: string; readonly message: string }[];
}

export interface CacheTierFailureEvent {
  readonly tier: string;
  readonly op: 'get' | 'set' | 'del';
  readonly key: string;
  readonly code?: string | undefined;
  readonly message: string;
}

/**
 * One line the process logger wrote — after redaction, so a subscriber never sees a secret. The
 * active span is the emitter's: a subscriber reads `currentSpanContext()` for trace correlation.
 */
export interface LogRecordEvent {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly message: string;
  /** The line's fields, redacted, the context's `requestId`/`traceId` included. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Every event the framework emits, name → payload. Closed: `INSTRUMENT_EVENTS` must list each. */
export interface FrameworkEventMap {
  'http.request': HttpRequestEvent;
  'db.statement': DbStatementEvent;
  'entity.row': EntityRowEvent;
  'entity.bulk': EntityBulkEvent;
  'entity.cross_tenant': EntityCrossTenantEvent;
  'policy.decision': PolicyDecisionEvent;
  'action.invoke': ActionInvokeEvent;
  'query.read': QueryReadEvent;
  'job.enqueue': JobEnqueueEvent;
  'job.perform': JobPerformEvent;
  'ai.llm': AiLlmEvent;
  'render.page': RenderPageEvent;
  'render.isr.regenerate': RenderIsrRegenerateEvent;
  'render.hole': RenderHoleEvent;
  'outbound.request': OutboundRequestEvent;
  'mail.deliver': MailDeliverEvent;
  'storage.put': StorageEvent;
  'storage.get': StorageEvent;
  'storage.stat': StorageEvent;
  'storage.copy': StorageEvent;
  'storage.delete': StorageEvent;
  'storage.list': StorageEvent;
  'cache.hit': CacheLookupEvent;
  'cache.miss': CacheLookupEvent;
  'cache.invalidate': CacheInvalidateEvent;
  'cache.tier_failure': CacheTierFailureEvent;
  /** A SAMPLED span, ended — the trace export stream. Unsampled spans never reach it. */
  'span.end': ReadableSpan;
  'log.record': LogRecordEvent;
}

/**
 * Every event the bus carries. AUGMENTABLE — an app declares its own names with
 * `declare module '@ultimat3/core' { interface InstrumentEventMap { 'billing.charged': … } }` and
 * emits them with the same `instrument()`. A name is lowercase dot-segments; the framework's first
 * segments (`INSTRUMENT_EVENTS`) are taken.
 */
export interface InstrumentEventMap extends FrameworkEventMap {}

/** `'event'`: a point fact, no span. Otherwise the OTel kind of the span its emitter opens. */
export type InstrumentSpan = SpanKind | 'event';

export interface InstrumentEventSpec {
  readonly span: InstrumentSpan;
  /** The package that emits it — the ONE place `instrument(name, …)` is called from. */
  readonly owner: string;
}

/** The framework's names, as a value: the docs, `x dev`'s panels and the tests read this. */
export const INSTRUMENT_EVENTS = Object.freeze({
  'http.request': { span: 'server', owner: '@ultimat3/http' },
  'db.statement': { span: 'client', owner: '@ultimat3/db' },
  'entity.row': { span: 'event', owner: '@ultimat3/entity' },
  'entity.bulk': { span: 'event', owner: '@ultimat3/entity' },
  'entity.cross_tenant': { span: 'event', owner: '@ultimat3/entity' },
  'policy.decision': { span: 'event', owner: '@ultimat3/policy' },
  'action.invoke': { span: 'internal', owner: '@ultimat3/action' },
  'query.read': { span: 'internal', owner: '@ultimat3/query' },
  'job.enqueue': { span: 'producer', owner: '@ultimat3/jobs' },
  'job.perform': { span: 'consumer', owner: '@ultimat3/jobs' },
  'ai.llm': { span: 'client', owner: '@ultimat3/ai' },
  'render.page': { span: 'internal', owner: '@ultimat3/render' },
  'render.isr.regenerate': { span: 'internal', owner: '@ultimat3/render' },
  'render.hole': { span: 'internal', owner: '@ultimat3/render' },
  'outbound.request': { span: 'client', owner: '@ultimat3/core' },
  'mail.deliver': { span: 'client', owner: '@ultimat3/mail' },
  'storage.put': { span: 'client', owner: '@ultimat3/storage' },
  'storage.get': { span: 'client', owner: '@ultimat3/storage' },
  'storage.stat': { span: 'client', owner: '@ultimat3/storage' },
  'storage.copy': { span: 'client', owner: '@ultimat3/storage' },
  'storage.delete': { span: 'client', owner: '@ultimat3/storage' },
  'storage.list': { span: 'client', owner: '@ultimat3/storage' },
  'cache.hit': { span: 'event', owner: '@ultimat3/cache' },
  'cache.miss': { span: 'event', owner: '@ultimat3/cache' },
  'cache.invalidate': { span: 'internal', owner: '@ultimat3/cache' },
  'cache.tier_failure': { span: 'event', owner: '@ultimat3/cache' },
  'span.end': { span: 'event', owner: '@ultimat3/core' },
  'log.record': { span: 'event', owner: '@ultimat3/core' },
} as const satisfies Record<keyof FrameworkEventMap, InstrumentEventSpec>);

/** A framework event name — the closed half of `InstrumentName`. */
export type FrameworkEventName = keyof typeof INSTRUMENT_EVENTS;
