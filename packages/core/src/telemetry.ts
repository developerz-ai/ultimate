// Single responsibility: OpenTelemetry-shaped tracing that is always on. An ended, sampled span
// is published on the instrumentation bus as `span.end` — every exporter is a subscriber, so an
// app with none pays nothing — and trace context is serialised explicitly (`traceparent`) so a
// trace survives HTTP -> job -> live query.

import { asyncContext } from './async-context';
import { type Clock, systemClock } from './clock';
import { tryUseContext } from './context';
import { renderThrowable } from './error-render';
import { isUltimateError } from './errors';
import { isSpanId, isTraceId, spanId as newSpanId, traceId as newTraceId } from './ids';
import { instrument, subscribed } from './instrument';
import { installTraceHeaders } from './outbound-headers';
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
  /** Events past `MAX_SPAN_EVENTS`, counted and not kept — OTLP's `droppedEventsCount`. */
  readonly droppedEventsCount: number;
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
  /**
   * Rename a span that learned what it is only after it started — an HTTP server span is opened
   * before the router matches, and its name must be the route PATTERN (`GET /r/:token`), never the
   * concrete URL, which carries capability tokens. A no-op once the span has ended.
   */
  updateName(name: string): Span;
  end(): void;
}

/**
 * What an exporter does with one span. Installed by SUBSCRIBING, never configured:
 * `subscribe('span.end', (event) => exporter.export(event.payload))`.
 */
export interface SpanExporter {
  export(span: ReadableSpan): void;
}

/**
 * The most events one span keeps. A span is held until it ends, and a loop that records an event
 * per row grew it without bound; past this the events are counted, not kept — the OTel SDK's own
 * default (`OTEL_SPAN_EVENT_COUNT_LIMIT=128`), and OTLP carries the count as `droppedEventsCount`.
 */
export const MAX_SPAN_EVENTS = 128;

export interface StartSpanOptions {
  readonly kind?: SpanKind | undefined;
  readonly attributes?: SpanAttributes | undefined;
  /** Explicit parent. Falls back to the active span, then to the request context's traceId. */
  readonly parent?: SpanContext | undefined;
  readonly links?: readonly SpanContext[] | undefined;
}

export interface TelemetryOptions {
  readonly clock?: Clock | undefined;
  readonly serviceName?: string | undefined;
  readonly serviceVersion?: string | undefined;
  readonly enabled?: boolean | undefined;
  /** Defaults to `defaultSampler()`: honour the parent, else the ratio the env asks for. */
  readonly sampler?: Sampler | undefined;
}

export interface MemoryExporter extends SpanExporter {
  readonly spans: readonly ReadableSpan[];
  reset(): void;
}

/**
 * For tests, and for reading back what a run traced with no collector on the box. Subscribe it:
 * `const off = subscribe('span.end', (event) => spans.export(event.payload))`.
 */
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

let clock: Clock = systemClock;
let enabled = true;
let sampler: Sampler | undefined;
let resource: SpanResource = Object.freeze({ serviceName: 'ultimate', serviceVersion: '0.0.1' });

export function configureTelemetry(options: TelemetryOptions): void {
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

/**
 * The trace the caller is inside: active span, else the request context, else a fresh trace.
 *
 * The context branch carries an EMPTY `spanId` on purpose, and that emptiness is the discriminator
 * every reader must honour: it is a trace id this process minted, not a span an upstream reported.
 * `traceFlags: 1` here is the header this process would send onward, never a decision it received.
 */
export function currentSpanContext(): SpanContext | undefined {
  const span = activeSpan.get();
  if (span !== undefined) return span.context;
  const ctx = tryUseContext();
  if (ctx === undefined) return undefined;
  return { traceId: ctx.traceId, spanId: '', traceFlags: 1 };
}

/**
 * A parent an upstream actually reported, as opposed to the synthetic one `currentSpanContext()`
 * builds from a request context. Only the first carries a sampling decision: reading the synthetic
 * one as inbound made `parentBasedRatioSampler` inherit a bit nobody sent, so every HTTP root span
 * was exported at every ratio — `pipeline.ts` is `runWithContext` then `withSpan`, which is that
 * exact pair — and the one lever between "tracing is on" and "the collector melts" did nothing.
 */
function inboundParent(parent: SpanContext | undefined): SpanContext | undefined {
  if (parent === undefined) return undefined;
  // A span this process started IS a real parent — asked first, because reading its `spanId`
  // would mint the id an unsampled span deliberately left unminted.
  if (parent instanceof LazySpanContext || parent instanceof SampledSpanContext) return parent;
  return parent.spanId === '' ? undefined : parent;
}

/**
 * A SAMPLED span's context: three own, enumerable fields, so a spread, `JSON.stringify` and
 * `structuredClone` carry all of them. A class, so `inboundParent` brands it with `instanceof`
 * instead of reading `spanId` (measured: an object literal with a getter and a symbol brand cost
 * ten times a class to build).
 */
class SampledSpanContext implements SpanContext {
  readonly spanId: string;
  readonly traceFlags = 1;
  constructor(readonly traceId: string) {
    this.spanId = newSpanId();
  }
}

/**
 * An UNSAMPLED span's context: its id is minted only when something reads it — a `traceparent`
 * sent onward, a sampled child's `parentSpanId` — because nothing else ever does, and the draw was
 * most of what an unsampled span cost (plan 101 slice 20: ≤ 1 µs). The getter lives on the
 * prototype, which a spread and `structuredClone` skip; `toJSON` keeps `JSON.stringify` whole, and
 * a caller copying a context reads `spanId` by name, as `SpanContext` declares it.
 */
class LazySpanContext implements SpanContext {
  readonly traceFlags = 0;
  #spanId: string | undefined;
  constructor(readonly traceId: string) {}
  get spanId(): string {
    this.#spanId ??= newSpanId();
    return this.#spanId;
  }
  toJSON(): SpanContext {
    return { traceId: this.traceId, spanId: this.spanId, traceFlags: this.traceFlags };
  }
}

export function startSpan(initialName: string, options?: StartSpanOptions): Span {
  let name = initialName;
  // A live span is what gives an outbound typed call a trace to continue; see the module.
  installTraceHeaders();
  const parent = options?.parent ?? currentSpanContext();
  const inbound = inboundParent(parent);
  const given = options?.attributes;
  const attributes: Record<string, AttributeValue> = given === undefined ? {} : { ...given };
  // The bit is decided ONCE, here, and every child of this span inherits it through `parent` —
  // so one trace is sampled or not sampled as a whole. Before this, `traceFlags` was hardcoded to
  // 1 for a root and `end()` exported regardless, which made the bit a value the framework
  // forwarded and nobody obeyed.
  // The id is resolved BEFORE the decision, because the decision may be a function of it: a
  // `traceidratio` sampler hashes the trace id, and a root's id exists nowhere else to hash.
  const traceId = parent?.traceId ?? newTraceId();
  const sampled = currentSampler().shouldSample(name, inbound, attributes, traceId);
  const context: SpanContext = sampled
    ? new SampledSpanContext(traceId)
    : new LazySpanContext(traceId);
  const events: SpanEvent[] = [];
  let droppedEventsCount = 0;
  const pushEvent = (event: SpanEvent): void => {
    if (events.length < MAX_SPAN_EVENTS) events.push(event);
    else droppedEventsCount += 1;
  };
  // Read only for a span that can be exported: an unsampled one never reports a time.
  const startedAt = sampled ? clock.now().getTime() : 0;
  const startedMono = sampled ? clock.monotonic() : 0;
  let status: SpanStatus = { code: 'unset' };
  let ended = false;

  const span: Span = {
    get name(): string {
      return name;
    },
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
      if (!sampled) return span;
      pushEvent({
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
      if (sampled) {
        pushEvent({
          name: 'exception',
          at: clock.now().getTime(),
          attributes: { 'error.code': code, 'error.message': message },
        });
      }
      status = { code: 'error', message };
      return span;
    },
    setStatus(code, message) {
      status = { code, message };
      return span;
    },
    updateName(next) {
      if (!ended) name = next;
      return span;
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (!enabled) return;
      // The whole point of propagating a sampling bit is that somebody obeys it. A span still
      // exists, still parents its children and still carries the decision onward in
      // `traceparent`; it is simply not exported.
      if (!sampled) return;
      // Nobody exporting: no record is built. Checked after the sampling bit, so `span.end` is
      // the export stream — a subscriber that wants every occurrence hears the domain event.
      if (!subscribed('span.end')) return;
      const endedAt = clock.now().getTime();
      const parentSpanId = inbound?.spanId;
      instrument('span.end', {
        name,
        kind: options?.kind ?? 'internal',
        context,
        parentSpanId,
        startedAt,
        endedAt,
        durationMs: clock.monotonic() - startedMono,
        attributes,
        events,
        droppedEventsCount,
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
 * `traceId` came from `uuidV7()` renders a 36-character dashed header here that `parseTraceparent`
 * — and every OTLP collector — rejects, so mint the pair with those two generators.
 */
export function traceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, '0');
  // The empty `spanId` `currentSpanContext()` synthesises is the one value this function cannot
  // interpolate bare: `00-<trace>--01` is 39 characters and `TRACEPARENT_RE` — like every
  // collector — rejects it, so the trace the header exists to continue is lost either way. A
  // freshly minted id is what a propagator with no reported parent sends, and it keeps the trace
  // id joinable. Deliberately not all-zero: `parseTraceparent` refuses that, as the spec requires.
  const parentId = context.spanId === '' ? newSpanId() : context.spanId;
  return `00-${context.traceId}-${parentId}-${flags}`;
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
