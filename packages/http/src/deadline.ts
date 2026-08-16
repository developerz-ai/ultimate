// The per-request deadline: the one thing that makes `ctx.signal` real. Nothing in this package
// created an `AbortController` before, so `throwIfAborted()` and `fetch(url, { signal })` were
// documented seams wired to nothing — a hung vendor call held its connection and its DB pool slot
// until the process died, and SIGTERM then waited out the whole drain budget for work that would
// never finish.

import type { HttpConfig } from './config';
import { requestTimedOut } from './errors';

/**
 * A caller may SHORTEN this request's deadline, never lengthen it. Honoured without trusting the
 * proxy, because the only thing it can buy an attacker is a faster 504 for their own request.
 */
export const REQUEST_TIMEOUT_HEADER = 'x-request-timeout-ms';

export interface Deadline {
  /** Aborted when the deadline passes. Handed to the context as `ctx.signal`. */
  readonly signal: AbortSignal;
  /** Rejects with `X_TIMEOUT` at the deadline; `undefined` when there is no deadline. */
  readonly expired: Promise<never> | undefined;
  readonly timeoutMs: number;
  /** Always call it — a live timer keeps the event loop from going idle. */
  clear(): void;
}

const NEVER_ABORTED: AbortSignal = new AbortController().signal;

const NO_DEADLINE: Deadline = {
  signal: NEVER_ABORTED,
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
}): Deadline => {
  const timeoutMs = resolveTimeoutMs(input.headers, input.config);
  if (timeoutMs <= 0) return NO_DEADLINE;

  const controller = new AbortController();
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
    signal: controller.signal,
    expired,
    timeoutMs,
    clear: () => clearTimeout(timer),
  };
};
