// Single responsibility: OpenTelemetry-shaped tracing that is always on. The default exporter
// is a no-op so unconfigured apps pay nothing, and trace context is serialised explicitly
// (`traceparent`) so a trace survives HTTP -> job -> live query.

import { asyncContext } from './async-context';
import { type Clock, systemClock } from './clock';
import { tryUseContext } from './context';
import { renderThrowable } from './error-render';
import { isUltimateError } from './errors';
import { isSpanId, isTraceId, spanId as newSpanId, traceId as newTraceId } from './ids';
import { defaultSampler, resetDefaultSampler, type Sampler } from './sampler';

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export type AttributeValue = string | number | boolean | readonly string[] | readonly number[];

export interface SpanAttributes {
  readonly [key: string]: AttributeValue;
}

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** Bit 0 = sampled, per W3C trace-context. */
  readonly traceFlags: number;
}

export interface SpanEvent {
  readonly name: string;
  readonly at: number;
  readonly attributes: SpanAttributes;
}

export type SpanStatusCode = 'unset' | 'ok' | 'error';

export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly message?: string | undefined;
}

export interface ReadableSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly parentSpanId: string | undefined;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly attributes: SpanAttributes;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
  readonly links: readonly SpanContext[];
  readonly resource: SpanResource;
}

export interface SpanResource {
  readonly serviceName: string;
  readonly serviceVersion: string;
}

export interface Span {
  readonly name: string;
  readonly context: SpanContext;
  readonly ended: boolean;
  setAttribute(key: string, value: AttributeValue): Span;
  setAttributes(attributes: SpanAttributes): Span;
  addEvent(name: string, attributes?: SpanAttributes): Span;
  recordError(error: unknown): Span;
  setStatus(code: SpanStatusCode, message?: string): Span;
  end(): void;
}

export interface SpanExporter {
  export(span: ReadableSpan): void;
}

export interface StartSpanOptions {
  readonly kind?: SpanKind | undefined;
  readonly attributes?: SpanAttributes | undefined;
  /** Explicit parent. Falls back to the active span, then to the request context's traceId. */
  readonly parent?: SpanContext | undefined;
  readonly links?: readonly SpanContext[] | undefined;
}

export interface TelemetryOptions {
  readonly exporter?: SpanExporter | undefined;
  readonly clock?: Clock | undefined;
  readonly serviceName?: string | undefined;
  readonly serviceVersion?: string | undefined;
  readonly enabled?: boolean | undefined;
  /** Defaults to `defaultSampler()`: honour the parent, else the ratio the env asks for. */
  readonly sampler?: Sampler | undefined;
}

export const noopExporter: SpanExporter = Object.freeze({
  export(): void {
    // Intentionally empty: tracing is always on, and free until an exporter is configured.
  },
});

export interface MemoryExporter extends SpanExporter {
  readonly spans: readonly ReadableSpan[];
  reset(): void;
}

/** For tests, and for reading back what a run traced with no collector on the box. */
export function memoryExporter(): MemoryExporter {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    export(span: ReadableSpan): void {
      spans.push(span);
    },
    reset(): void {
      spans.length = 0;
    },
  };
}

// The same lazily-opened seam `context.ts` uses, and for the same reason: a module-scope
// `new AsyncLocalStorage()` throws at EVALUATION in a browser bundle, taking every importer of
// `@ultimat3/core` down with it. `async-context.ts` owns the argument.
const activeSpan = asyncContext<Span>('the active span');

let exporter: SpanExporter = noopExporter;
let clock: Clock = systemClock;
let enabled = true;
let sampler: Sampler | undefined;
let resource: SpanResource = Object.freeze({ serviceName: 'ultimate', serviceVersion: '0.0.1' });

export function configureTelemetry(options: TelemetryOptions): void {
  if (options.exporter !== undefined) exporter = options.exporter;
  if (options.clock !== undefined) clock = options.clock;
  if (options.enabled !== undefined) enabled = options.enabled;
  if (options.sampler !== undefined) sampler = options.sampler;
  if (options.serviceName !== undefined || options.serviceVersion !== undefined) {
    resource = Object.freeze({
      serviceName: options.serviceName ?? resource.serviceName,
      serviceVersion: options.serviceVersion ?? resource.serviceVersion,
    });
  }
}

export function resetTelemetry(): void {
  exporter = noopExporter;
  clock = systemClock;
  enabled = true;
  sampler = undefined;
  resetDefaultSampler();
}

/** The sampler in force: whatever `configureTelemetry` was given, else the env's. */
export function currentSampler(): Sampler {
  return sampler ?? defaultSampler();
}

/**
 * The service identity every signal carries. One resource for spans and metrics alike, as OTel
 * defines it — a metric that named a different service than its own traces is unjoinable.
 */
export function serviceResource(): SpanResource {
  return resource;
}

export function currentSpan(): Span | undefined {
  return activeSpan.get();
}

/** The trace the caller is inside: active span, else the request context, else a fresh trace. */
export function currentSpanContext(): SpanContext | undefined {
  const span = activeSpan.get();
  if (span !== undefined) return span.context;
  const ctx = tryUseContext();
  if (ctx === undefined) return undefined;
  return { traceId: ctx.traceId, spanId: '', traceFlags: 1 };
}

export function startSpan(name: string, options?: StartSpanOptions): Span {
  const parent = options?.parent ?? currentSpanContext();
  const attributes: Record<string, AttributeValue> = { ...(options?.attributes ?? {}) };
  // The bit is decided ONCE, here, and every child of this span inherits it through `parent` —
  // so one trace is sampled or not sampled as a whole. Before this, `traceFlags` was hardcoded to
  // 1 for a root and `end()` exported regardless, which made the bit a value the framework
  // forwarded and nobody obeyed.
  const context: SpanContext = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    traceFlags: currentSampler().shouldSample(name, parent, attributes) ? 1 : 0,
  };
  const events: SpanEvent[] = [];
  const startedAt = clock.now().getTime();
  const startedMono = clock.monotonic();
  let status: SpanStatus = { code: 'unset' };
  let ended = false;

  const span: Span = {
    name,
    context,
    get ended(): boolean {
      return ended;
    },
    setAttribute(key, value) {
      attributes[key] = value;
      return span;
    },
    setAttributes(next) {
      for (const [key, value] of Object.entries(next)) attributes[key] = value;
      return span;
    },
    addEvent(eventName, eventAttributes) {
      events.push({
        name: eventName,
        at: clock.now().getTime(),
        attributes: eventAttributes ?? {},
      });
      return span;
    },
    recordError(error) {
      const code = isUltimateError(error) ? error.code : 'X_INTERNAL';
      // `renderThrowable`, never `error instanceof Error ? error.message : String(error)`: both
      // halves are property reads on a value the framework did not build, and this runs inside
      // `withSpan`'s catch — around `cache.invalidate`, `db.<verb>` and every HTTP and job span.
      // A throw here substitutes the tracer's own TypeError for the caller's real failure and
      // leaves the span it was annotating unended.
      const message = renderThrowable(error);
      events.push({
        name: 'exception',
        at: clock.now().getTime(),
        attributes: { 'error.code': code, 'error.message': message },
      });
      status = { code: 'error', message };
      return span;
    },
    setStatus(code, message) {
      status = { code, message };
      return span;
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (!enabled) return;
      // The whole point of propagating a sampling bit is that somebody obeys it. A span still
      // exists, still parents its children and still carries the decision onward in
      // `traceparent`; it is simply not exported.
      if ((context.traceFlags & 1) === 0) return;
      const endedAt = clock.now().getTime();
      const parentSpanId = parent === undefined || parent.spanId === '' ? undefined : parent.spanId;
      exporter.export({
        name,
        kind: options?.kind ?? 'internal',
        context,
        parentSpanId,
        startedAt,
        endedAt,
        durationMs: clock.monotonic() - startedMono,
        attributes,
        events,
        status,
        links: options?.links ?? [],
        resource,
      });
    },
  };
  return span;
}

/** Runs `fn` inside a span, ending it on return, resolve or throw. Sync and async both work. */
export function withSpan<T>(name: string, fn: (span: Span) => T, options?: StartSpanOptions): T {
  const span = startSpan(name, options);
  return activeSpan.run(span, () => {
    try {
      const result = fn(span);
      if (isPromiseLike(result)) {
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (reason: unknown) => {
            span.recordError(reason);
            span.end();
            throw reason;
          },
        ) as unknown as T;
      }
      span.end();
      return result;
    } catch (thrown) {
      span.recordError(thrown);
      span.end();
      throw thrown;
    }
  });
}

/** Continue an inbound trace. The HTTP, job and realtime layers all call this. */
export function withSpanContext<T>(context: SpanContext, name: string, fn: (span: Span) => T): T {
  return withSpan(name, fn, { parent: context });
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Round-trips with `traceId()` / `spanId()` from `ids.ts` and with nothing else. A context whose
 * `traceId` came from `uuid()` renders a 36-character dashed header here that `parseTraceparent`
 * — and every OTLP collector — rejects, so mint the pair with those two generators.
 */
export function traceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

export function parseTraceparent(header: string | null | undefined): SpanContext | undefined {
  if (header === null || header === undefined) return undefined;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (match === null) return undefined;
  const traceId = match[1] as string;
  const spanId = match[2] as string;
  // `ids.ts` owns what a valid id is, so the all-zero rejection the spec requires lives in one
  // place instead of being a second regex here that drifts from the generator's.
  if (!isTraceId(traceId) || !isSpanId(spanId)) return undefined;
  return { traceId, spanId, traceFlags: Number.parseInt(match[3] as string, 16) };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}
