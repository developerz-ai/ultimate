// Single responsibility: the shapes of one `outbound()` call — the request, the injected seams and
// the answer — plus the defaults they fall back to. Types and constants only, so the attempt, the
// call and a caller's wrapper can share them without importing each other.

import type { Schema } from '@ultimat3/schema';
import type { Random } from './backoff';
import type { Breaker } from './breaker';
import type { DeadlineTimer } from './deadline-signal';
import type { DialResolve } from './outbound-dial';
import type { RetryPolicy } from './retry-loop';

export type OutboundMethod = 'GET' | 'HEAD' | 'PUT' | 'DELETE' | 'POST' | 'PATCH' | 'OPTIONS';

/** Re-sendable bodies only: a retry or a 307 hop sends the body again, and a stream cannot. */
export type OutboundBody =
  | string
  | Uint8Array<ArrayBuffer>
  | ArrayBuffer
  | Blob
  | URLSearchParams
  | FormData;

/** What one hop is sent with. `tls.serverName` is the name a PINNED connection proves. */
export type OutboundInit = RequestInit & {
  readonly tls?: { readonly serverName?: string } | undefined;
};

/** "Just the call", the seam `MailFetch` already is. Its `init` always carries the signal. */
export type OutboundFetch = (url: string, init: OutboundInit) => Promise<Response>;

export interface OutboundRequest {
  readonly url: string | URL;
  /** A bounded label chosen in code (`'resend'`), in every log line and cause. */
  readonly vendor: string;
  /**
   * Which network the URL may reach — a decision per call, so it is required. `'public'` screens
   * every address the name answers and pins the connection; `'named'` dials a host the app itself
   * names in code (a configured endpoint, a sidecar) as written.
   */
  readonly dial: 'named' | 'public';
  /** The WHOLE call, retries and waits included. Clamped by the ambient request's own deadline. */
  readonly deadlineMs: number;
  readonly method?: OutboundMethod | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: OutboundBody | undefined;
  /** The longest gap between two body chunks, in ms. Default `OUTBOUND_IDLE_MS`. */
  readonly idleMs?: number | undefined;
  /** Default `OUTBOUND_MAX_BYTES`. */
  readonly maxBytes?: number | undefined;
  /** `'error'` by default: a 3xx is `X_OUTBOUND_REDIRECTED`, never a silent hop. */
  readonly redirect?: 'error' | 'follow' | undefined;
  /** Default `OUTBOUND_RETRY` for GET, HEAD, PUT, DELETE, OPTIONS; one attempt for POST, PATCH. */
  readonly retry?: RetryPolicy | undefined;
  /** A POST or PATCH carrying the vendor's idempotency key: retried as a safe method is. */
  readonly idempotent?: true | undefined;
  readonly read?: 'bytes' | 'stream' | undefined;
  /**
   * A signal of the caller's own, heard BESIDE the ambient `ctx.signal` — a fan-out's cancel. Its
   * reason reaches the caller unchanged, as the context's does.
   */
  readonly signal?: AbortSignal | undefined;
  /** Recorded once per call, after the retries: a 503 retried away is not a failure. */
  readonly breaker?: Breaker | undefined;
}

export interface OutboundDeps {
  readonly fetch?: OutboundFetch | undefined;
  readonly resolve?: DialResolve | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Monotonic ms. */
  readonly now?: (() => number) | undefined;
  readonly random?: Random | undefined;
  /** The deadline and idle timers. A test fires it instead of waiting. */
  readonly timer?: DeadlineTimer | undefined;
  /** Which environment decides whether a public dial may use `http:`. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

interface OutboundHead {
  readonly status: number;
  readonly headers: Headers;
}

/** A 2xx, read whole. Anything else was thrown as a coded error. */
export interface OutboundAnswer extends OutboundHead {
  readonly bytes: Uint8Array;
  text(): string;
  /** The body through `schema`: `X_OUTBOUND_BODY_INVALID` when it does not fit. */
  json<T>(schema: Schema<unknown, T>): T;
}

/** A 2xx whose body is read by the caller, under the same idle watchdog, cap and deadline. */
export interface OutboundStreamAnswer extends OutboundHead {
  readonly stream: ReadableStream<Uint8Array>;
}

/** Three tries, 250 ms then up to 5 s apart, full jitter. */
export const OUTBOUND_RETRY: RetryPolicy = Object.freeze({
  attempts: 3,
  base: 250,
  max: 5_000,
  jitter: 'full',
});

export const OUTBOUND_IDLE_MS = 30_000;
export const OUTBOUND_MAX_BYTES = 16 * 1024 * 1024;
/** Hops a `redirect: 'follow'` call takes before it is `X_OUTBOUND_REDIRECTED`. */
export const OUTBOUND_MAX_REDIRECTS = 5;
