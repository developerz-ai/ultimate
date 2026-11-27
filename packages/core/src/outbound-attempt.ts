// Single responsibility: ONE attempt of an `outbound()` call — its signal, its hops, its status
// read as a coded answer (a refusal's body as the call's `refusal` asks), and its body under the
// idle watchdog and the cap. Every way it ends is classified here, so `retry()` above it reads a
// code, never an unclassified throw (measured: one from a POST ran three attempts).

import type { Schema } from '@ultimat3/schema';
import { retryAfterSecondsOf } from './client-retry-after';
import { tryUseContext } from './context';
import type { DeadlineTimer } from './deadline-signal';
import { deadlineSignal } from './deadline-signal';
import { isUltimateError } from './errors';
import { logger, redactFields } from './logger';
import {
  callerDeadline,
  outboundRedirected,
  outboundRefused,
  outboundThrottled,
  outboundTimeout,
  outboundTooLarge,
  outboundUnavailable,
  outboundUnreachable,
} from './outbound-errors';
import type { HopCall } from './outbound-hops';
import { redactedLocation, sendHops } from './outbound-hops';
import type { WatchedFailure } from './outbound-read';
import { watchedBody } from './outbound-read';
import { refusalHeadersOf } from './outbound-refusal-headers';
import type { OutboundRefusalRead } from './outbound-types';
import { readWithinLimit } from './read-capped';
import { isRetryableStatus } from './retryable-status';

export interface AttemptCall extends HopCall {
  /** The call's own signal, heard beside the ambient one. */
  readonly signal: AbortSignal | undefined;
  /** Monotonic instant the whole call must end by. */
  readonly endsAt: number;
  readonly deadlineMs: number;
  readonly idleMs: number;
  readonly maxBytes: number;
  readonly read: 'bytes' | 'stream';
  /** How a non-2xx body is read for the error; `undefined` is the default excerpt. */
  readonly refusal: OutboundRefusalRead | undefined;
  /** The `refusal.headers` names, validated and lowercased (`refusalHeaderNames`); none asked: `undefined`. */
  readonly refusalHeaders: readonly string[] | undefined;
  readonly now: () => number;
  readonly timer: DeadlineTimer;
}

/** What a settled attempt hands up: a 2xx, with its body read or still to be read. */
export type AttemptAnswer =
  | { readonly status: number; readonly headers: Headers; readonly bytes: Uint8Array }
  | {
      readonly status: number;
      readonly headers: Headers;
      readonly stream: ReadableStream<Uint8Array>;
    };

/** What the error carries from the body. */
interface RefusalBody {
  readonly detail: string;
  readonly fields?: unknown;
}

/** How many bytes of a refusal's body are read for its `meta.detail`, and how much is kept. */
const DETAIL_READ_BYTES = 1_024;
const DETAIL_CHARS = 200;

/** The first `DETAIL_READ_BYTES` of a body, the rest cancelled unread: an endless 5xx stays cheap. */
async function prefixOf(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < DETAIL_READ_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

const parsedJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

/**
 * A JSON OBJECT, redacted by key, or nothing: raw text is never kept. A body cut at the prefix,
 * an array, a form (`client_secret=…`) or an HTML page carries a credential no key names.
 */
function detailOf(text: string): string {
  const parsed = parsedJson(text)?.value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
  return JSON.stringify(redactFields(parsed as Record<string, unknown>)).slice(0, DETAIL_CHARS);
}

/** The schema's answer, redacted at any depth, or `undefined` when the body does not fit it. */
function fieldsOf(text: string, schema: Schema<unknown, unknown>): unknown {
  const parsed = parsedJson(text);
  if (parsed === undefined) return undefined;
  const result = schema.safeParse(parsed.value);
  if (!('value' in result) || result.issues !== undefined) return undefined;
  return redactFields({ fields: result.value })['fields'];
}

async function wholeBody(
  body: ReadableStream<Uint8Array>,
  read: OutboundRefusalRead & { readonly schema: Schema<unknown, unknown> },
  maxBytes: number,
): Promise<RefusalBody> {
  const capped = await readWithinLimit(body, maxBytes);
  if ('over' in capped) return { detail: '' };
  const text = new TextDecoder().decode(capped.bytes);
  const fields = fieldsOf(text, read.schema);
  return {
    detail: read.detail === false ? '' : detailOf(text),
    ...(fields === undefined ? {} : { fields }),
  };
}

/** What the error keeps of a refusal's body, as `read` asks. Never throws. */
async function refusalBodyOf(
  body: ReadableStream<Uint8Array>,
  read: OutboundRefusalRead | undefined,
  maxBytes: number,
): Promise<RefusalBody> {
  try {
    if (read?.schema !== undefined)
      return await wholeBody(body, { ...read, schema: read.schema }, maxBytes);
    if (read?.detail === false) {
      await body.cancel().catch(() => undefined);
      return { detail: '' };
    }
    return { detail: detailOf(await prefixOf(body)) };
  } catch {
    return { detail: '' };
  }
}

/** The ambient request's time left, in ms, or `Infinity` when it has no deadline. */
function ambientLeftMs(): number {
  const ctx = tryUseContext();
  if (ctx === undefined || ctx.deadlineAt === null) return Number.POSITIVE_INFINITY;
  return ctx.deadlineAt - ctx.now().getTime();
}

/** A non-2xx as the code it is. The body has been read for the detail, or cancelled. */
async function refusalOf(
  call: AttemptCall,
  response: Response,
  body: ReadableStream<Uint8Array>,
): Promise<unknown> {
  const { site, url } = call;
  const { status, headers } = response;
  const kept =
    call.refusalHeaders === undefined ? undefined : refusalHeadersOf(call.refusalHeaders, headers);
  if (status >= 300 && status < 400) {
    await body.cancel().catch(() => undefined);
    const location = headers.get('location');
    const where = location === null ? 'nowhere' : redactedLocation(location, url);
    return outboundRedirected(site, status, where);
  }
  if (isRetryableStatus(status)) {
    const after = retryAfterSecondsOf(headers.get('retry-after'), headers.get('date'));
    const { detail, fields } = await refusalBodyOf(body, call.refusal, call.maxBytes);
    return after === undefined
      ? outboundUnavailable(site, status, detail, fields, kept)
      : outboundThrottled(site, status, after, detail, fields, kept);
  }
  const { detail, fields } = await refusalBodyOf(body, call.refusal, call.maxBytes);
  return outboundRefused(site, status, detail, fields, kept);
}

export async function runAttempt(call: AttemptCall, attempt: number): Promise<AttemptAnswer> {
  const startedAt = call.now();
  // The ambient caller's signal and the call's own, each heard; neither composed into one that
  // could not be undone (`AbortSignal.any` would leave a listener on a long-lived one per call).
  const outers = [tryUseContext()?.signal, call.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const gone = (): AbortSignal | undefined => outers.find((signal) => signal.aborted);
  const outer = {
    get aborted() {
      return gone() !== undefined;
    },
    get reason(): unknown {
      return gone()?.reason;
    },
  };
  if (outer.aborted) throw outer.reason;
  // Whole milliseconds, up: a timer armed for 899.97 ms is a 900 ms deadline read late.
  const ownLeft = call.endsAt - startedAt;
  const ambientLeft = ambientLeftMs();
  // Which bound fires decides the code: the caller's own deadline is no fact about the vendor.
  const callerBinds = ambientLeft < ownLeft;
  const timedOut = (): unknown =>
    callerBinds
      ? callerDeadline(call.site)
      : outboundTimeout(call.site, 'deadline', call.deadlineMs);
  const leftMs = Math.ceil(Math.min(ownLeft, ambientLeft));
  if (leftMs <= 0) throw timedOut();
  const local = new AbortController();
  const forward = (): void => local.abort(outer.reason);
  for (const signal of outers) signal.addEventListener('abort', forward, { once: true });
  const deadline = deadlineSignal(leftMs, local.signal, call.timer);
  let idle = false;
  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    deadline[Symbol.dispose]();
    for (const signal of outers) signal.removeEventListener('abort', forward);
  };
  // A caller gone is ITS reason, unchanged (`X_DRAINING` keeps its meaning); else which bound fired.
  const coded = (error: unknown): unknown => {
    if (outer.aborted) return outer.reason;
    if (isUltimateError(error)) return error;
    if (deadline.timedOut()) return timedOut();
    if (idle) return outboundTimeout(call.site, 'idle', call.idleMs);
    return outboundUnreachable(call.site, error);
  };
  const failure = (cause: WatchedFailure): unknown => {
    if (cause.kind === 'too-large') return outboundTooLarge(call.site, call.maxBytes);
    return coded(cause.kind === 'idle' ? undefined : cause.error);
  };
  let status: number | undefined;
  try {
    const response = await sendHops(call, deadline.signal);
    status = response.status;
    const body = watchedBody(response.body ?? new Blob([]).stream(), {
      idleMs: call.idleMs,
      ...(call.read === 'stream' ? { maxBytes: call.maxBytes } : {}),
      timer: call.timer,
      signal: deadline.signal,
      onIdle: () => {
        idle = true;
        local.abort();
      },
      failure,
      onSettled: release,
    });
    if (status < 200 || status >= 300) throw await refusalOf(call, response, body);
    if (call.read === 'stream') {
      logAttempt(call, attempt, startedAt, status, undefined);
      return { status, headers: response.headers, stream: body };
    }
    const read = await readWithinLimit(body, call.maxBytes);
    if ('over' in read) throw outboundTooLarge(call.site, call.maxBytes);
    logAttempt(call, attempt, startedAt, status, undefined);
    return { status, headers: response.headers, bytes: read.bytes };
  } catch (error) {
    const thrown = coded(error);
    logAttempt(call, attempt, startedAt, status, thrown);
    release();
    throw thrown;
  } finally {
    if (call.read === 'bytes') release();
  }
}

/**
 * One line per attempt: the call's label, never its query or headers. `debug` for an answer,
 * `warn` for a failure, so a healthy vendor costs no line at the default level.
 */
function logAttempt(
  call: AttemptCall,
  attempt: number,
  startedAt: number,
  status: number | undefined,
  thrown: unknown,
): void {
  const fields = {
    ...call.site,
    attempt,
    ms: Math.round(call.now() - startedAt),
    ...(status === undefined ? {} : { status }),
  };
  if (thrown === undefined) {
    logger.debug('outbound.attempt', fields);
    return;
  }
  logger.warn('outbound.attempt', {
    ...fields,
    code: isUltimateError(thrown) ? thrown.code : 'uncoded',
  });
}
