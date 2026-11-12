// Single responsibility: one `ErrorReporter` that speaks the Sentry ENVELOPE wire format. A
// serialisation, not a vendor (axiom 7, exactly as `metrics-text.ts` is to Prometheus): the format
// is documented and several self-hostable monitors ingest it. Nothing here names a host, a project
// or an organisation — the DSN is the app's own typed env, passed in at wiring time.

import { monitorFingerprint } from './error-fingerprint';
import { renderThrowable } from './error-render';
import type { ErrorReport, ErrorReporter, ErrorSeverity } from './error-reporter';
import {
  admitted,
  customFingerprint,
  finalEvent,
  type SentryEvent,
  type SentryReporterOptions,
  screenSampleRate,
} from './error-reporter-sentry-hooks';
import { type CodedErrorInit, UltimateError } from './errors';
import { traceId } from './ids';
import { logger, redactFields } from './logger';
import { sentryFrames } from './sentry-frames';

export type { SentryReporterOptions } from './error-reporter-sentry-hooks';

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
const LEVELS = Object.freeze<Record<ErrorSeverity, string>>({
  warning: 'warning',
  error: 'error',
  fatal: 'fatal',
});

export interface SentryEnvelopeOptions {
  readonly dsn: string;
  /** 32 lowercase hex, no dashes. `traceId()` already produces exactly that shape. */
  readonly eventId: string;
  /** The monitor's grouping. Default: `monitorFingerprint(report)`. */
  readonly fingerprint?: readonly string[] | undefined;
}

/** The event an envelope carries, before `beforeSend` and serialisation. Pure. */
export function sentryEvent(report: ErrorReport, options: SentryEnvelopeOptions): SentryEvent {
  return payloadOf(report, options.eventId, options.fingerprint);
}

function payloadOf(
  report: ErrorReport,
  eventId: string,
  fingerprint: readonly string[] | undefined,
): Record<string, unknown> {
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
    // The group: the code, so one fault raised from five operations is one issue — never the
    // monitor's own reading of the frames, which splits it per call site (`monitorFingerprint`).
    fingerprint: fingerprint ?? monitorFingerprint(report),
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
      // The caller's two records go through `redactFields`, and FIRST. Spread raw and last, a
      // `bigint` or a cycle in `meta` made `JSON.stringify` throw — that error was never reported
      // — `meta: { fix, stack }` replaced the framework's own, and `meta.password` left the box.
      ...redactFields(report.scope.extra ?? {}),
      // The whole point of reporting the framework's contract instead of a message: whoever is
      // paged reads the runnable fix next to the failure.
      fix: report.fix,
      docs: report.docs,
      ...(report.scope.requestId === undefined ? {} : { requestId: report.scope.requestId }),
      ...(report.scope.actorId === undefined ? {} : { actorId: report.scope.actorId }),
      ...(report.stack === undefined ? {} : { stack: report.stack }),
      // Under its own key, so no name an error author picks can collide with one above.
      ...(report.meta === undefined ? {} : { meta: redactFields(report.meta) }),
    },
    exception: { values: [exceptionOf(report)] },
  };
}

/** The one exception value: the contract as type and value, the throw's frames when there are any. */
function exceptionOf(report: ErrorReport): Record<string, unknown> {
  const frames = sentryFrames(report.stack);
  return {
    type: report.code,
    value: `${report.title} — ${report.cause}`,
    // `extra.stack` keeps the raw string for one release beside these (31.6.0); a monitor rule
    // reading it has that long to move.
    ...(frames.length === 0 ? {} : { stacktrace: { frames } }),
  };
}

/** Pure, so the wire format is a unit test rather than a thing discovered in production. */
export function sentryEnvelope(report: ErrorReport, options: SentryEnvelopeOptions): string {
  return envelopeOf(sentryEvent(report, options), options, report.at);
}

/** The three lines around one event. The item `length` is measured off THIS payload. */
function envelopeOf(event: SentryEvent, options: SentryEnvelopeOptions, at: number): string {
  const payload = JSON.stringify(event);
  const header = JSON.stringify({
    event_id: options.eventId,
    sent_at: new Date(at).toISOString(),
    dsn: options.dsn,
  });
  const item = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
    length: new TextEncoder().encode(payload).length,
  });
  return `${header}\n${item}\n${payload}\n`;
}

/**
 * Every reporter that is an app's Sentry transport: built by `sentryErrorReporter`, or marked by
 * `sentryTransport`. Identity, never shape: a reporter is `{ report }`, and the boot must tell an
 * app's own transport from its `errorGroupsSink` exactly.
 */
const built = new WeakSet<ErrorReporter>();

/**
 * Whether `reporter` is the app's Sentry transport — built by `sentryErrorReporter` or marked by
 * `sentryTransport` — not a chain holding one (`errorReportersOf` flattens a chain to ask its
 * members). The `SENTRY_DSN` boot asks it so an app's transport is the only one, never doubled.
 */
export function isSentryErrorReporter(reporter: ErrorReporter): boolean {
  return built.has(reporter);
}

/**
 * The one way to WRAP the Sentry transport: `sentryTransport({ report: (r) => inner.report(tag(r)) })`.
 * Marks `reporter` as the app's Sentry transport and returns it, so a boot with `SENTRY_DSN` set
 * adds no second, unscrubbed one beside it — a wrapper is `{ report }` and could be anything else.
 */
export function sentryTransport<R extends ErrorReporter>(reporter: R): R {
  built.add(reporter);
  return reporter;
}

/** Every reporter marked by `localErrorSink`: its reports stay on the box. */
const local = new WeakSet<ErrorReporter>();

/**
 * Marks `reporter` as a LOCAL sink — it keeps reports on the box (a table, memory, the log) and
 * sends nothing to a monitor — and returns it. The `SENTRY_DSN` boot still adds its transport
 * beside reporters that are all local sinks; an unmarked one might be a transport, so it does not.
 * The framework's own are marked: `memoryErrorReporter`, `@ultimat3/admin`'s `errorGroupsSink`.
 */
export function localErrorSink<R extends ErrorReporter>(reporter: R): R {
  local.add(reporter);
  return reporter;
}

/** Whether `localErrorSink` marked `reporter` — a single reporter, never a chain. */
export function isLocalErrorSink(reporter: ErrorReporter): boolean {
  return local.has(reporter);
}

/**
 * Fire-and-forget on purpose. A report is not the request, and awaiting the monitor would add its
 * latency — and its outages — to every failure the app already knows how to answer.
 */
export function sentryErrorReporter(options: SentryReporterOptions): ErrorReporter {
  const dsn = parseSentryDsn(options.dsn);
  const rate = screenSampleRate(options.sampleRate);
  const send = options.fetch ?? globalThis.fetch;
  const client = options.clientName ?? 'ultimate';
  const auth = `Sentry sentry_version=7, sentry_client=${client}, sentry_key=${dsn.publicKey}`;
  const reporter: ErrorReporter = {
    report(report: ErrorReport): void {
      if (!admitted(report, options, rate)) return;
      const envelope = {
        dsn: options.dsn,
        eventId: traceId(),
        fingerprint: customFingerprint(report, options),
      };
      const event = finalEvent(sentryEvent(report, envelope), options);
      if (event === null) return;
      // The event may now hold a hook's value — `beforeSend`'s rewrite, `fingerprint`'s list — and
      // a `bigint` or a cycle there throws in `JSON.stringify`. `report()` runs inside every failure
      // path's catch, so that is a dropped event and a warn line, never a second throw.
      let body: string;
      try {
        body = envelopeOf(event, envelope, report.at);
      } catch (thrown) {
        logger.warn('error reporter event could not be serialised; the event was dropped', {
          code: report.code,
          error: renderThrowable(thrown),
        });
        return;
      }
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
  built.add(reporter);
  return reporter;
}
