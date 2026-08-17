// Single responsibility: one `ErrorReporter` that speaks the Sentry ENVELOPE wire format. A
// serialisation, not a vendor (axiom 7, exactly as `metrics-text.ts` is to Prometheus): the format
// is documented and several self-hostable monitors ingest it. Nothing here names a host, a project
// or an organisation — the DSN is the app's own typed env, passed in at wiring time.

import { renderThrowable } from './error-render';
import type { ErrorReport, ErrorReporter, ErrorSeverity } from './error-reporter';
import { type CodedErrorInit, UltimateError } from './errors';
import { traceId } from './ids';
import { logger } from './logger';

export class ErrorReporterDsnInvalidError extends UltimateError {
  static readonly code = 'X_ERROR_REPORTER_DSN_INVALID';
  override readonly name = 'ErrorReporterDsnInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: ErrorReporterDsnInvalidError.code });
  }
}

export interface SentryDsn {
  readonly publicKey: string;
  readonly projectId: string;
  /** Where an envelope is POSTed. Derived from the DSN, never configured separately. */
  readonly envelopeUrl: string;
}

const DSN_FIX =
  'set the monitor DSN in .env to https://<publicKey>@<host>/<projectId>, then run: x env check';

/**
 * `https://<publicKey>@<host>[:<port>][/<path>]/<projectId>`. Parsed at wiring time rather than at
 * the first error: a typo discovered by the first outage is a monitor that was never connected.
 */
export function parseSentryDsn(dsn: string): SentryDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new ErrorReporterDsnInvalidError({
      cause: `"${dsn}" is not a URL`,
      fix: DSN_FIX,
      meta: { dsn },
    });
  }
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const projectId = segments.pop();
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username === '' ||
    projectId === undefined
  ) {
    throw new ErrorReporterDsnInvalidError({
      cause: `"${url.protocol}//${url.host}${url.pathname}" has no publicKey, no projectId or a non-HTTP scheme`,
      fix: DSN_FIX,
      meta: { dsn },
    });
  }
  const prefix = segments.length === 0 ? '' : `/${segments.join('/')}`;
  return {
    publicKey: url.username,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

/** The protocol's own level names. `warning`/`error`/`fatal` happen to be the same three words. */
const LEVELS: Readonly<Record<ErrorSeverity, string>> = Object.freeze({
  warning: 'warning',
  error: 'error',
  fatal: 'fatal',
});

export interface SentryEnvelopeOptions {
  readonly dsn: string;
  /** 32 lowercase hex, no dashes. `traceId()` already produces exactly that shape. */
  readonly eventId: string;
}

function payloadOf(report: ErrorReport, eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    // Seconds, as the protocol spells a timestamp. `new Date` here converts a number the caller
    // supplied; it never reads a clock, which stays `clock.ts`'s job.
    timestamp: report.at / 1000,
    platform: 'javascript',
    level: LEVELS[report.severity],
    logger: report.source,
    environment: report.environment,
    server_name: report.resource.serviceName,
    ...(report.release === null ? {} : { release: report.release }),
    ...(report.scope.operation === undefined ? {} : { transaction: report.scope.operation }),
    // Tags are the monitor's facets, so only bounded values go here — the same rule metric labels
    // follow. `requestId` and `actorId` are unbounded and live in `extra`.
    tags: {
      code: report.code,
      source: report.source,
      service_version: report.resource.serviceVersion,
      ...(report.scope.role === undefined ? {} : { role: report.scope.role }),
    },
    ...(report.scope.traceId === undefined
      ? {}
      : {
          contexts: {
            trace: {
              trace_id: report.scope.traceId,
              ...(report.scope.spanId === undefined ? {} : { span_id: report.scope.spanId }),
            },
          },
        }),
    extra: {
      // The whole point of reporting the framework's contract instead of a message: whoever is
      // paged reads the runnable fix next to the failure.
      fix: report.fix,
      docs: report.docs,
      ...(report.scope.requestId === undefined ? {} : { requestId: report.scope.requestId }),
      ...(report.scope.actorId === undefined ? {} : { actorId: report.scope.actorId }),
      ...(report.stack === undefined ? {} : { stack: report.stack }),
      ...(report.meta ?? {}),
      ...(report.scope.extra ?? {}),
    },
    exception: { values: [{ type: report.code, value: `${report.title} — ${report.cause}` }] },
  };
}

/** Pure, so the wire format is a unit test rather than a thing discovered in production. */
export function sentryEnvelope(report: ErrorReport, options: SentryEnvelopeOptions): string {
  const payload = JSON.stringify(payloadOf(report, options.eventId));
  const header = JSON.stringify({
    event_id: options.eventId,
    sent_at: new Date(report.at).toISOString(),
    dsn: options.dsn,
  });
  const item = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
    length: new TextEncoder().encode(payload).length,
  });
  return `${header}\n${item}\n${payload}\n`;
}

export interface SentryReporterOptions {
  /** From the app's typed env. The framework declares no default and ships no constant. */
  readonly dsn: string;
  /** Injected by tests; the preload seals the real one. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly clientName?: string | undefined;
}

/**
 * Fire-and-forget on purpose. A report is not the request, and awaiting the monitor would add its
 * latency — and its outages — to every failure the app already knows how to answer.
 */
export function sentryErrorReporter(options: SentryReporterOptions): ErrorReporter {
  const dsn = parseSentryDsn(options.dsn);
  const send = options.fetch ?? globalThis.fetch;
  const client = options.clientName ?? 'ultimate';
  const auth = `Sentry sentry_version=7, sentry_client=${client}, sentry_key=${dsn.publicKey}`;
  return {
    report(report: ErrorReport): void {
      const body = sentryEnvelope(report, { dsn: options.dsn, eventId: traceId() });
      void send(dsn.envelopeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': auth },
        body,
      }).catch((failure: unknown) => {
        logger.warn('error reporter delivery failed', {
          url: dsn.envelopeUrl,
          // `renderThrowable`: this is the `.catch` that keeps a monitor outage from becoming a
          // second failure, so rendering the rejection may not raise one of its own.
          error: renderThrowable(failure),
        });
      });
    },
  };
}
