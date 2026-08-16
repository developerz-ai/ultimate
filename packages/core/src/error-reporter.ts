// Single responsibility: the error-monitoring seam — every surface reports a caught error through
// ONE `ErrorReporter`. Shaped exactly like `telemetry.ts` and `metrics.ts`: always on, a no-op
// driver by default, and the wire format supplied by a transport, never here. The framework names
// no vendor (axiom 7); a transport takes its endpoint from the app's typed env.

import { type Clock, systemClock } from './clock';
import { tryUseContext } from './context';
import { DEFAULT_ENVIRONMENT, type Environment, tryResolveEnvironment } from './environment';
import { isUltimateError, toUltimateError } from './errors';
import { logger } from './logger';
import type { Role } from './roles';
import { currentSpanContext, type SpanResource, serviceResource } from './telemetry';

export type ErrorSeverity = 'warning' | 'error' | 'fatal';

/**
 * Which surface caught it. A closed list on purpose: this becomes a facet in the monitor, and a
 * free-form string here is the same unbounded-cardinality mistake that a user id in a metric
 * label is. A new surface adds a member; it never passes a string of its own.
 */
export const ERROR_SOURCES = ['http', 'job', 'realtime', 'cli', 'process'] as const;

export type ErrorSource = (typeof ERROR_SOURCES)[number];

export interface ErrorScope {
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly role?: Role | undefined;
  /** The route PATTERN, the job name, the frame type — never a concrete path or a row id. */
  readonly operation?: string | undefined;
  readonly actorId?: string | undefined;
  /** Anything else worth reading during triage. Not a facet: never indexed, never grouped on. */
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What a reporter receives. The framework's error contract verbatim — a monitor groups on `code`
 * and shows `fix` to whoever is paged, which is the whole reason a report carries more than a
 * message string.
 */
export interface ErrorReport {
  /** Epoch milliseconds, from the configured clock. */
  readonly at: number;
  readonly severity: ErrorSeverity;
  readonly source: ErrorSource;
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  readonly stack: string | undefined;
  readonly resource: SpanResource;
  readonly environment: Environment;
  /** The deploy's own id — `BUILD_ID`, the same value `x-ultimate-build` carries. */
  readonly release: string | null;
  readonly scope: ErrorScope;
  /** The value that was actually thrown. A transport may read it; nothing else should. */
  readonly error: unknown;
}

/** The driver seam. A self-hosted monitor, an OTLP logs exporter or a file all arrive as one. */
export interface ErrorReporter {
  report(event: ErrorReport): void;
}

export const noopErrorReporter: ErrorReporter = Object.freeze({
  report(): void {
    // Intentionally empty: reporting is always on, and free until a transport is configured.
  },
});

export interface MemoryErrorReporter extends ErrorReporter {
  readonly events: readonly ErrorReport[];
  reset(): void;
}

/** For tests, and for a `x dev` process that shows its own failures without leaving the box. */
export function memoryErrorReporter(): MemoryErrorReporter {
  const events: ErrorReport[] = [];
  return {
    events,
    report(event: ErrorReport): void {
      events.push(event);
    },
    reset(): void {
      events.length = 0;
    },
  };
}

export interface ErrorReportingOptions {
  readonly reporter?: ErrorReporter | undefined;
  readonly clock?: Clock | undefined;
  /** The deploy's build id. `serve.ts` passes the one it already computed; never a second one. */
  readonly release?: string | null | undefined;
  readonly environment?: Environment | undefined;
  readonly enabled?: boolean | undefined;
}

let reporter: ErrorReporter = noopErrorReporter;
let clock: Clock = systemClock;
let release: string | null = null;
let environment: Environment | undefined;
let enabled = true;

export function configureErrorReporting(options: ErrorReportingOptions): void {
  if (options.reporter !== undefined) reporter = options.reporter;
  if (options.clock !== undefined) clock = options.clock;
  if (options.release !== undefined) release = options.release;
  if (options.environment !== undefined) environment = options.environment;
  if (options.enabled !== undefined) enabled = options.enabled;
}

export function resetErrorReporting(): void {
  reporter = noopErrorReporter;
  clock = systemClock;
  release = null;
  environment = undefined;
  enabled = true;
}

function environmentNow(): Environment {
  // A malformed `ULTIMATE_ENV` is its own error with its own code and its own fix. Failing to tag
  // a report with an environment must never replace the error being reported — which is why the
  // non-throwing resolver is core's, not a `try` around the throwing one here: two call sites
  // catching the same throw is two places the policy can drift.
  return environment ?? tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT;
}

export interface ReportErrorOptions {
  readonly source: ErrorSource;
  /** Default `error`. `warning` is for a failure the framework already recovered from. */
  readonly severity?: ErrorSeverity | undefined;
  readonly scope?: ErrorScope | undefined;
}

/**
 * Normalise a throwable into an `ErrorReport`. Exported so a transport can be tested against a
 * report built the same way the runtime builds one, and so a surface can enrich before sending.
 * The ambient context and the active span fill in whatever the caller did not name.
 */
export function errorReport(error: unknown, options: ReportErrorOptions): ErrorReport {
  const normalized = toUltimateError(error);
  const ctx = tryUseContext();
  const span = currentSpanContext();
  /**
   * Trace and span resolve as a PAIR, from one source, and never field by field. Falling back
   * per-field let a caller-supplied `traceId` pick up the *ambient* `spanId`, so a report claimed
   * a span that belongs to a different trace — whoever is paged then opens the wrong span inside
   * the right trace, which is worse than no span at all because it looks authoritative. A caller
   * naming a trace is making a statement; the ambient span only fills a silence.
   */
  const trace: { traceId: string | undefined; spanId: string | undefined } =
    options.scope?.traceId === undefined
      ? {
          traceId: span?.traceId ?? ctx?.traceId,
          spanId: span?.spanId === '' ? undefined : span?.spanId,
        }
      : { traceId: options.scope.traceId, spanId: options.scope.spanId };
  const scope: ErrorScope = {
    requestId: options.scope?.requestId ?? ctx?.requestId,
    traceId: trace.traceId,
    spanId: trace.spanId,
    role: options.scope?.role ?? ctx?.role,
    operation: options.scope?.operation,
    actorId: options.scope?.actorId ?? ctx?.actor.id,
    extra: options.scope?.extra,
  };
  return {
    at: clock.now().getTime(),
    severity: options.severity ?? 'error',
    source: options.source,
    code: normalized.code,
    title: normalized.title,
    cause: normalized.cause,
    fix: normalized.fix,
    docs: normalized.docs,
    meta: normalized.meta,
    // The thrown value's own stack, not the wrapper's: `toUltimateError` builds its `InternalError`
    // at this line, so the wrapper's stack points here rather than at the throw.
    stack: (isUltimateError(error) ? error : error instanceof Error ? error : normalized).stack,
    resource: serviceResource(),
    environment: environmentNow(),
    release: release ?? ctx?.buildId ?? null,
    scope,
    error,
  };
}

/**
 * The one call every surface makes. It never throws and never rejects: a monitor that is down
 * must not turn one failure into two, and the surface that caught this has already logged it.
 */
export function reportError(error: unknown, options: ReportErrorOptions): void {
  if (!enabled) return;
  try {
    reporter.report(errorReport(error, options));
  } catch (failure) {
    logger.warn('error reporter failed', {
      source: options.source,
      error: failure instanceof Error ? failure.message : String(failure),
    });
  }
}
