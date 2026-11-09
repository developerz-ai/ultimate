// Single responsibility: `outbound()`, the one outbound HTTP call — screen the request, run its
// attempts through core's `retry()` (which owns the clamp to the ambient caller), record the
// breaker once, and hand back a 2xx. Three adopters built this client and agreed on every property;
// the parts were in core already, unassembled. Server-only: `@ultimat3/core/outbound`, never the barrel.

import type { Schema } from '@ultimat3/schema';
import type { Breaker } from './breaker';
import { settleWith } from './breaker';
import { systemClock } from './clock';
import { tryUseContext } from './context';
import { platformDeadlineTimer } from './deadline-signal';
import { isLocal } from './environment';
import { isUltimateError } from './errors';
import { finiteCount } from './finite-option';
import type { AttemptAnswer, AttemptCall } from './outbound-attempt';
import { runAttempt } from './outbound-attempt';
import type { OutboundSite } from './outbound-errors';
import { isCallerBound, outboundBodyInvalid, outboundRetryUnsafe } from './outbound-errors';
import { redactedPath } from './outbound-hops';
import { instrumentedCall } from './outbound-instrument';
import type {
  OutboundAnswer,
  OutboundDeps,
  OutboundFetch,
  OutboundRequest,
  OutboundStreamAnswer,
} from './outbound-types';
import { OUTBOUND_IDLE_MS, OUTBOUND_MAX_BYTES, OUTBOUND_RETRY } from './outbound-types';
import { retry } from './retry';
import type { RetryPolicy } from './retry-loop';

/** The platform's `fetch`, closed over (a detached `fetch` is "Illegal invocation" on some hosts). */
const platformFetch: OutboundFetch = (target, init) =>
  fetch(target, { ...init, signal: init.signal ?? null });

/** A backoff wait the call's OWN signal also ends; `retry()` already hears the ambient one. */
const signalledSleep =
  (signal: AbortSignal) =>
  (ms: number): Promise<void> =>
    new Promise<void>((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    });

/** A write the vendor cannot tell from a second one: never replayed without its key. */
const UNSAFE = new Set(['POST', 'PATCH']);

const ONE_ATTEMPT: RetryPolicy = Object.freeze({ attempts: 1, base: 0, max: 0, jitter: 'none' });

function policyFor(request: OutboundRequest, site: OutboundSite): RetryPolicy {
  const unsafe = UNSAFE.has(site.method) && request.idempotent !== true;
  // Refused at the call, before a byte: a replayed charge is not a failure a log line repairs.
  if (unsafe && request.retry !== undefined) throw outboundRetryUnsafe(site);
  const policy = request.retry ?? (unsafe ? ONE_ATTEMPT : OUTBOUND_RETRY);
  const budget = policy.timeBudgetMs ?? Number.POSITIVE_INFINITY;
  return { ...policy, timeBudgetMs: Math.min(budget, request.deadlineMs) };
}

function prepare(request: OutboundRequest, deps: OutboundDeps): AttemptCall {
  const url = new URL(request.url);
  const method = request.method ?? 'GET';
  const site: OutboundSite = {
    vendor: request.vendor,
    method,
    origin: url.origin,
    path: redactedPath(url.pathname),
  };
  const deadlineMs = finiteCount('outbound()', 'deadlineMs', request.deadlineMs, 1);
  const now = deps.now ?? ((): number => systemClock.monotonic());
  const send = deps.fetch ?? platformFetch;
  return {
    site,
    url,
    method,
    headers: { ...request.headers },
    body: request.body,
    dial: request.dial,
    redirect: request.redirect ?? 'error',
    local: isLocal({ env: deps.env, fallback: 'production' }),
    fetch: send,
    resolve: deps.resolve,
    endsAt: now() + deadlineMs,
    deadlineMs,
    idleMs: finiteCount('outbound()', 'idleMs', request.idleMs ?? OUTBOUND_IDLE_MS, 1),
    maxBytes: finiteCount('outbound()', 'maxBytes', request.maxBytes ?? OUTBOUND_MAX_BYTES),
    read: request.read ?? 'bytes',
    signal: request.signal,
    now,
    timer: deps.timer ?? platformDeadlineTimer,
  };
}

/** Once per CALL, after the retries; a caller gone gives the probe back and counts nothing. */
async function guarded(
  gate: Breaker,
  signal: AbortSignal | undefined,
  work: () => Promise<AttemptAnswer>,
): Promise<AttemptAnswer> {
  const ticket = gate.admit();
  if (ticket === undefined) throw gate.refusal();
  try {
    const answer = await work();
    gate.succeeded(ticket);
    return answer;
  } catch (error) {
    // A caller gone, or the caller's own deadline spent, says nothing about the vendor.
    const gone =
      tryUseContext()?.signal.aborted === true || signal?.aborted === true || isCallerBound(error);
    settleWith(gate, gone ? 'ignore' : gate.judge(error), ticket);
    throw error;
  }
}

function bytesAnswer(site: OutboundSite, answer: AttemptAnswer & { bytes: Uint8Array }) {
  const text = (): string => new TextDecoder().decode(answer.bytes);
  return {
    status: answer.status,
    headers: answer.headers,
    bytes: answer.bytes,
    text,
    json<T>(schema: Schema<unknown, T>): T {
      let value: unknown;
      try {
        value = JSON.parse(text());
      } catch {
        throw outboundBodyInvalid(site, ['the body is not JSON']);
      }
      const result = schema.safeParse(value);
      if ('value' in result && result.issues === undefined) return result.value;
      const issues = (result.issues ?? []).map(
        (issue) =>
          (issue.path ?? [])
            .map((part) => String(typeof part === 'object' ? part.key : part))
            .join('.') || '(root)',
      );
      throw outboundBodyInvalid(site, issues);
    },
  } satisfies OutboundAnswer;
}

/**
 * One outbound HTTP call, every property decided: a deadline over the WHOLE call, the ambient
 * request's signal and deadline honoured (`runToCompletion` lifts both, its `bound` sets them
 * again), safe-only retry with `Retry-After`, an idle watchdog and a byte cap on the body, a 3xx
 * never followed unless asked, and every failure a code whose cause names no query or header.
 */
export async function outbound(
  request: OutboundRequest & { readonly read: 'stream' },
  deps?: OutboundDeps,
): Promise<OutboundStreamAnswer>;
export async function outbound(
  request: OutboundRequest & { readonly read?: 'bytes' | undefined },
  deps?: OutboundDeps,
): Promise<OutboundAnswer>;
export async function outbound(
  request: OutboundRequest,
  deps: OutboundDeps = {},
): Promise<OutboundAnswer | OutboundStreamAnswer> {
  const call = prepare(request, deps);
  const policy = policyFor(request, call.site);
  const work = (): Promise<AttemptAnswer> =>
    retry((attempt) => runAttempt(call, attempt), policy, {
      sleep:
        deps.sleep ?? (request.signal === undefined ? undefined : signalledSleep(request.signal)),
      now: call.now,
      random: deps.random,
    });
  const answer = await instrumentedCall(
    { vendor: call.site.vendor, method: call.method, url: call.url },
    () => (request.breaker === undefined ? work() : guarded(request.breaker, request.signal, work)),
  );
  if ('stream' in answer) return answer;
  return bytesAnswer(call.site, answer);
}

/**
 * `outbound()` for a caller whose existing code READS a refusal: the final answer as a `Response`
 * whatever its status. Every property above still holds — deadline, signal, retry, caps, redaction
 * (a refusal's body is its redacted 200-character `meta.detail`) — and a call that got no answer
 * still throws its code. For a driver mapping statuses onto codes it already shipped.
 */
export async function outboundResponse(
  request: OutboundRequest & { readonly read?: 'bytes' | undefined },
  deps: OutboundDeps = {},
): Promise<Response> {
  // The last answer's HEADERS, kept for the refusal rebuilt below: a vendor names its error type
  // in one (SES's `x-amzn-ErrorType`), and a cause never carries a header.
  let lastHeaders: Headers | undefined;
  const send = deps.fetch ?? platformFetch;
  const recording: OutboundFetch = async (target, init) => {
    const response = await send(target, init);
    lastHeaders = response.headers;
    return response;
  };
  try {
    const answer = await outbound(request, { ...deps, fetch: recording });
    return new Response(answer.bytes.slice(), { status: answer.status, headers: answer.headers });
  } catch (error) {
    const refused = refusalResponse(error, lastHeaders);
    if (refused === undefined) throw error;
    return refused;
  }
}

/** The answer a coded refusal carried, rebuilt: its status, its stated delay, its detail. */
function refusalResponse(error: unknown, received: Headers | undefined): Response | undefined {
  if (!isUltimateError(error) || !error.code.startsWith('X_OUTBOUND_')) return undefined;
  const status = error.meta?.['status'];
  if (typeof status !== 'number') return undefined;
  const detail = error.meta?.['detail'];
  const after = error.meta?.['retryAfterSeconds'];
  const headers = new Headers(received);
  // The body is the detail now, never the vendor's bytes: their length and encoding no longer hold.
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (typeof after === 'number') headers.set('retry-after', String(after));
  return new Response(typeof detail === 'string' ? detail : '', { status, headers });
}
