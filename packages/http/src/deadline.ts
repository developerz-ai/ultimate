// The per-request deadline: the one thing that makes `ctx.signal` real. Nothing in this package
// created an `AbortController` before, so `throwIfAborted()` and `fetch(url, { signal })` were
// documented seams wired to nothing — a hung vendor call held its connection and its DB pool slot
// until the process died, and SIGTERM then waited out the whole drain budget for work that would
// never finish.

import { REQUEST_TIMEOUT_HEADER, systemClock } from '@ultimat3/core';
import type { HttpConfig } from './config';
import { requestTimedOut } from './errors';

/**
 * A caller may SHORTEN this request's deadline, never lengthen it. Honoured without trusting the
 * proxy, because the only thing it can buy an attacker is a faster 504 for their own request.
 *
 * The name is core's, re-exported rather than declared twice: this package READS the header and
 * `@ultimat3/core`'s typed-client wire path WRITES it, and a second literal is a propagation that
 * stops working the day one of the two strings is edited. Same shape as `logger.ts` re-exporting
 * `REDACTED` — one definition, one public path.
 */
export { REQUEST_TIMEOUT_HEADER };

export interface Deadline {
  /** Aborted when the deadline passes. Handed to the context as `ctx.signal`. */
  readonly signal: AbortSignal;
  /**
   * Epoch ms the budget runs out at, or `null` when there is none — `ctx.deadlineAt`, and what an
   * outbound hop subtracts `now` from. Real monotonic time (`systemClock`), never an injected
   * clock, for the reason the drain budget is: the timer beside it runs on `setTimeout`, so a
   * frozen clock would publish an instant the abort will not honour.
   */
  readonly deadlineAt: number | null;
  /** Rejects with `X_TIMEOUT` at the deadline; `undefined` when there is no deadline. */
  readonly expired: Promise<never> | undefined;
  readonly timeoutMs: number;
  /** Always call it — a live timer keeps the event loop from going idle. */
  clear(): void;
}

const NEVER_ABORTED: AbortSignal = new AbortController().signal;

const NO_DEADLINE: Deadline = {
  signal: NEVER_ABORTED,
  deadlineAt: null,
  expired: undefined,
  timeoutMs: 0,
  clear: () => undefined,
};

/** The configured budget, or the caller's if theirs is shorter. `0` means "no deadline". */
export const resolveTimeoutMs = (headers: Headers, config: HttpConfig): number => {
  const configured = config.requestTimeoutMs;
  const raw = headers.get(REQUEST_TIMEOUT_HEADER);
  if (raw === null) return configured;
  const asked = Number.parseInt(raw, 10);
  if (!Number.isFinite(asked) || asked < 1) return configured;
  return configured > 0 ? Math.min(configured, asked) : asked;
};

/**
 * One timer and one controller per request. The abort is the cooperative half — app code that
 * passed `ctx.signal` unwinds on its own — and `expired` is the half that answers the socket
 * either way, because a handler ignoring the signal must still not hold the connection forever.
 */
export const startDeadline = (input: {
  readonly headers: Headers;
  readonly config: HttpConfig;
  readonly method: string;
  readonly pathname: string;
  /**
   * The INBOUND `Request.signal` — the caller-went-away half of `ctx.signal`. Optional because a
   * context can exist without a request (a job, a test), never because a server may skip it.
   */
  readonly clientSignal?: AbortSignal | undefined;
}): Deadline => {
  const timeoutMs = resolveTimeoutMs(input.headers, input.config);
  const client = input.clientSignal;
  // The caller's own signal, not the shared never-aborted one: with no deadline configured every
  // request used to share a module-level singleton, so a handler that added an `abort` listener
  // accumulated one per request for the life of the process — and no request could learn its
  // caller had gone. `NO_DEADLINE` is left for the callers that genuinely have no client.
  if (timeoutMs <= 0) {
    return client === undefined ? NO_DEADLINE : { ...NO_DEADLINE, signal: client };
  }

  const controller = new AbortController();
  // Read BEFORE the timer is armed, so the published instant is never later than the abort.
  const deadlineAt = systemClock.now().getTime() + timeoutMs;
  let fire: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    fire = () => reject(requestTimedOut(input.method, input.pathname, timeoutMs));
  });
  // A rejection nothing is awaiting is an unhandled rejection, and a process that dies on the
  // first slow request is worse than the slow request. `Promise.race` attaches its own handler;
  // this one is for the caller that reads `signal` and never the promise.
  void expired.catch(() => undefined);
  const timer = setTimeout(() => {
    controller.abort(requestTimedOut(input.method, input.pathname, timeoutMs));
    fire?.();
  }, timeoutMs);

  return {
    deadlineAt,
    // Both halves, or the doc on `ctx.signal` is half true — which it was: nothing in this package
    // read the inbound signal, so a browser closing the tab left the request holding its pool slot
    // and its vendor connection for the whole budget, for a caller that is gone. `expired` stays
    // the TIMER's alone: it is what answers the socket, and a socket the caller already closed has
    // nothing to answer.
    signal: client === undefined ? controller.signal : AbortSignal.any([client, controller.signal]),
    expired,
    timeoutMs,
    clear: () => clearTimeout(timer),
  };
};
