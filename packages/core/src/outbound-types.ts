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

/** A proxy as Bun's `fetch` takes it: an `http:`/`https:` URL, with the `CONNECT` headers. */
export interface OutboundProxyInit {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * What one hop is sent with. `tls.serverName` is the name a PINNED connection proves; it applies
 * to the target inside a proxy's tunnel, never to the proxy (Bun 1.4.4, measured).
 */
export type OutboundInit = RequestInit & {
  readonly tls?: { readonly serverName?: string } | undefined;
  readonly proxy?: OutboundProxyInit | undefined;
};

/** One proxy: its URL (credentials may ride it), or the URL and the headers its `CONNECT` sends. */
export type OutboundProxyTarget =
  | string
  | URL
  | {
      readonly url: string | URL;
      readonly headers?: Readonly<Record<string, string>> | undefined;
    };

/**
 * A proxy for every hop, or a resolver asked once per hop with the hop's NAMED url (never the
 * pinned address) — `undefined` dials that hop direct. Which proxy, and rotating them, is the app's.
 */
export type OutboundProxy =
  | OutboundProxyTarget
  | ((target: URL) => OutboundProxyTarget | undefined | Promise<OutboundProxyTarget | undefined>);

/**
 * "Just the call", the seam `MailFetch` already is — a test double, or a production transport.
 * `outbound()` keeps the screen, the deadline, retries, the byte cap, the idle watchdog and every
 * redirect rule: the transport is handed the SCREENED url (the approved address under `'public'`,
 * with `host` and `tls.serverName` naming the name) and `init` with `signal` and `redirect:
 * 'manual'`. It must dial that url and pass `init` through. An answer with `redirected: true` is
 * `X_OUTBOUND_TRANSPORT_REDIRECTED`. A transport that reaches somewhere else (a tunnel, a relay)
 * takes the address screen over: that is the app's to prove.
 */
export type OutboundFetch = (url: string, init: OutboundInit) => Promise<Response>;

/** How a refusal's body is read, per call: `OutboundRequest.refusal`. */
export interface OutboundRefusalRead {
  /**
   * The body read whole (up to the call's `maxBytes`), parsed as JSON through this schema: what it
   * answers, credential-named fields redacted, is the error's `meta.fields`. A body that is not
   * JSON, does not fit, or passes `maxBytes` leaves `meta.fields` unset.
   */
  readonly schema?: Schema<unknown, unknown> | undefined;
  /**
   * `false`: `meta.detail` is `''`, the raw-body excerpt never kept. Default `true`. It does not
   * filter `meta.fields`: a schema declares only fields that are safe to log.
   */
  readonly detail?: boolean | undefined;
  /**
   * Response header names (case-insensitive) kept on the error: the ones the answer carries go to
   * `meta.headers`, a record of lowercased name to value, each value redacted and cut at 200
   * characters. Unset: no header is kept. For the vendor's request id, to quote in a support
   * ticket. At most 16 names, each at most 64 characters; a credential-named one (`set-cookie`,
   * `authorization`, `www-authenticate`, `x-api-key` …), an overlong name or a name that is not a
   * header is `X_INVARIANT` at the call, before a byte is sent.
   */
  readonly headers?: readonly string[] | undefined;
}

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
   * How a non-2xx body is read for the coded error. Unset: a redacted 200-character excerpt of
   * the chunks that decode its first 1,024 characters, `meta.detail`. `{ schema }`: the whole body (within `maxBytes`) through the
   * schema, its answer at `meta.fields`. `{ detail: false }`: `meta.detail` stays `''`.
   */
  readonly refusal?: OutboundRefusalRead | undefined;
  /**
   * A signal of the caller's own, heard BESIDE the ambient `ctx.signal` — a fan-out's cancel. Its
   * reason reaches the caller unchanged, as the context's does.
   */
  readonly signal?: AbortSignal | undefined;
  /** Recorded once per call, after the retries: a 503 retried away is not a failure. */
  readonly breaker?: Breaker | undefined;
  /**
   * Send each hop through an HTTP proxy (`CONNECT` for `https:`). Under `dial: 'public'` the screen
   * still runs first and the tunnel is opened to the approved ADDRESS, the certificate still proven
   * against the name; the proxy itself is the app's own choice, like a `'named'` host.
   *
   * Unset: the app-wide proxy, `outbound.proxy` in `app.config.ts`, when one is declared (never
   * for loopback or an `outbound.direct` host). A resolver answering `undefined` — `proxy: () =>
   * undefined` — dials this call direct regardless: the one spelling, so the field's type is 31.x's.
   */
  readonly proxy?: OutboundProxy | undefined;
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
