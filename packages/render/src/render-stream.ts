/**
 * `stream` — the default for `app/` pages. A genuinely static shell is flushed on the
 * first tick; every `<Hole>` becomes a slot that is filled out of order, in
 * completion order, as its data resolves.
 *
 * Why the shell is free here: Solid compiles templates to DOM operations and tracks
 * updates with signals, so there is no VDOM tree to replay and no hydration pass over the
 * shell. A resolved hole patches the exact nodes bound to it; the surrounding markup is
 * never re-executed. In a VDOM framework a streamed shell still pays to hydrate the whole
 * tree, which buys TTFB but not TBT — here it buys both, so a `<Hole>` that
 * contains no interactive island costs literally zero JS.
 */

import {
  BUILD_ID_HEADER,
  escapeHtml,
  finiteCount,
  logger,
  renderThrowable,
  reportError,
  UltimateError,
} from '@ultimat3/core';
import { finiteStatus } from './finite-status';
import type { RenderResult } from './route';
import { REVEAL_BODY, REVEAL_CALL } from './stream-scripts';

export interface StreamHole {
  /** Stable within a response; becomes the DOM id, so keep it short. */
  readonly id: string;
  /** Rendered synchronously into the first flush (`<Hole fallback>`). */
  readonly fallback: string;
  /** This hole's own markup when it rejects or misses its deadline (`<Hole error>`). */
  readonly error?: string;
  /**
   * Scripts for the chunk, after its `$X()`: asked once `resolve` answered, so it can see what the
   * hole's render recorded (a hole's island needs a runtime the first flush could not know of).
   */
  readonly after?: (outcome: 'filled' | 'failed') => string;
  /**
   * `signal` aborts when the response is cancelled — a client that disconnected mid-stream. A
   * hole that ignores it still finishes; it just finishes into a document nobody reads.
   */
  readonly resolve: (signal: AbortSignal) => Promise<string>;
}

export interface StreamPlan {
  /** `<!doctype html><html …><head>…</head><body>` — everything before the shell. */
  readonly head: string;
  /** The shell markup, containing one `holeMarker()` per hole. */
  readonly shell: string;
  readonly holes: readonly StreamHole[];
  /** `</body></html>` — flushed after the last hole resolves. */
  readonly tail?: string;
}

const HOLE_PREFIX = 'x:';

export function holeId(id: string): string {
  return `${HOLE_PREFIX}${id}`;
}

/**
 * The placeholder that sits in the first flush, holding the fallback markup.
 *
 * `html.ts`'s escaper, not raw interpolation, for the reason `emitIslandAttributes` states: a `"`
 * in the id closes the attribute and the rest is markup. Author-controlled today — which is why it
 * costs nothing to route through the ONE escaper now, rather than after an id starts being derived
 * from a param. `fallback` is already-rendered HTML and stays verbatim.
 */
export function holeMarker(id: string, fallback: string): string {
  return `<x-hole id="${escapeHtml(holeId(id))}">${fallback}</x-hole>`;
}

/**
 * The entire client half of out-of-order streaming. Inline, uncompressed, ~200 bytes; it
 * moves a late `<template>`'s content into the placeholder that is already on screen.
 */
export const REVEAL_SCRIPT = `<script>${REVEAL_BODY}</script>`;

export function revealChunk(id: string, html: string, after = ''): string {
  // The id reaches markup ONLY through `escapeHtml` — never a script — so a quote in it
  // cannot close anything, and no per-hole body exists for a CSP to fail to list.
  return (
    `<template data-x-hole="${escapeHtml(holeId(id))}">${html}</template>` +
    `<script>${REVEAL_CALL}</script>${after}`
  );
}

/**
 * How long one hole may take before it is treated as failed. A hole is application code the
 * framework `await`s — a query with no statement timeout, a fetch with no `AbortSignal.timeout` —
 * and nothing else in the system bounds one: `settle` fires from the hole's own promise, so a
 * promise that never settles holds the response, the socket and everything its closure retains
 * for the life of the process. Long enough that a slow page still renders, short enough that a
 * hung one is a fallback rather than a leak.
 */
export const DEFAULT_HOLE_TIMEOUT_MS = 15_000;

export interface StreamOptions {
  readonly buildId: string;
  /** Rendered into a hole whose promise rejected. Keep it a token-styled inline block. */
  readonly errorFallback?: (holeId: string) => string;
  /**
   * Per-hole deadline in ms. `null` waits forever — the deliberate opt-out for a hole that owns
   * its own timeout, never the default, because "forever" is not a deadline anyone chose.
   */
  readonly holeTimeoutMs?: number | null;
  /**
   * While a hole is open, an empty comment every this many ms. Nothing else is written while a hole
   * waits, and Bun closes a socket idle for `idleTimeout` — `@ultimat3/http` derives it from
   * `requestTimeoutMs` (+2 s), so a 1 s deadline cut a 6 s hole at 3 s with no `</html>`. A write
   * resets Bun's idle timer (measured, Bun 1.4.4); clamping the hole deadline instead would cut a
   * legitimately slow hole, and render cannot see the socket's timeout to clamp to.
   */
  readonly keepAliveMs?: number;
}

/** Under the shortest `idleTimeout` `@ultimat3/http` derives: `ceil(requestTimeoutMs / 1000) + 2` ≥ 3 s. */
export const DEFAULT_STREAM_KEEPALIVE_MS = 1_000;

/** The keep-alive write: a comment, inert wherever the parser is between two chunks. */
export const STREAM_KEEPALIVE_CHUNK = '<!---->';

/**
 * `null` is the declared "this hole owns its own timeout" opt-out; every other value is a
 * deadline, and a deadline of 0 is not one — `setTimeout(fn, 0)` fires on the next tick and the
 * document becomes all fallbacks.
 */
const declaredTimeoutMs = (declared: number | null | undefined): number | null =>
  declared === undefined
    ? DEFAULT_HOLE_TIMEOUT_MS
    : declared === null
      ? null
      : finiteCount('renderStreamHtml', 'holeTimeoutMs', declared, 1);

/**
 * A hole's `resolve`, its synchronous throw included. `StreamHole` is public, so nothing makes it an
 * async function, and one that throws before returning a promise threw out of `renderStreamHtml`
 * with no byte sent. Called here and now, not a microtask later: every hole starts as the stream does.
 */
const startHole = (hole: StreamHole, signal: AbortSignal): Promise<string> => {
  try {
    return Promise.resolve(hole.resolve(signal));
  } catch (error) {
    return Promise.reject(error);
  }
};

/** A hole's `after`, which is app-shaped code too: a throw there costs the scripts, never the reveal. */
const afterOf = (hole: StreamHole, outcome: 'filled' | 'failed'): string => {
  try {
    return hole.after?.(outcome) ?? '';
  } catch (error) {
    logger.warn('render.stream.hole_after_failed', {
      hole: hole.id,
      error: renderThrowable(error),
    });
    return '';
  }
};

/** What a monitor hears when a hole misses its deadline: the visitor got the error markup. */
const holeDeadlineMissed = (id: string, timeoutMs: number): UltimateError =>
  new UltimateError({
    code: 'X_TIMEOUT',
    cause: `stream hole ${id} did not settle within ${timeoutMs} ms, so its error markup was shown`,
    fix: 'fetch(url, { signal: AbortSignal.timeout(5_000) }) — bound the read under the <Hole>',
  });

/**
 * Flush order is completion order, not declaration order — a fast hole never waits behind
 * a slow one. The stream closes only after every hole has settled, so a rejected boundary
 * degrades to its error fallback instead of truncating the document.
 */
export function renderStreamHtml(
  plan: StreamPlan,
  options: StreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const tail = plan.tail ?? '</body></html>';
  const errorFallback =
    // Escaped as `holeMarker` escapes the same id: it lands inside an attribute either way.
    options.errorFallback ?? ((id) => `<div data-x-hole-error="${escapeHtml(id)}" hidden></div>`);
  // A deadline is the bound a non-finite value does not disable but MOVES: `setTimeout(fn, NaN)`
  // is `setTimeout(fn, 0)`, so every hole would miss a deadline nobody set and the document would
  // be all fallbacks. `null` is the declared opt-out; there is no spelling that means "immediately".
  const timeoutMs = declaredTimeoutMs(options.holeTimeoutMs);
  const keepAliveMs = finiteCount(
    'renderStreamHtml',
    'keepAliveMs',
    options.keepAliveMs ?? DEFAULT_STREAM_KEEPALIVE_MS,
    1,
  );
  /**
   * The response's own lifetime. A client that disconnects mid-stream cancels the stream, and
   * both halves of that have to be honoured: nothing more may be enqueued — `settle`'s
   * `write(tail)`/`close()` on a cancelled controller threw out of a `void`ed promise, one
   * unhandled rejection per response — and the holes still running must be told to stop doing
   * their database work for a document nobody will read.
   */
  const holes = new AbortController();
  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        // `desiredSize` is null once the controller is closed or errored, which is the half a
        // cancellation flag cannot see on its own.
        if (closed || controller.desiredSize === null) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        controller.close();
      };

      // No holes, no reveal script: a page that streams nothing pays nothing.
      write(plan.head + (plan.holes.length > 0 ? REVEAL_SCRIPT : '') + plan.shell);

      let pending = plan.holes.length;
      if (pending === 0) {
        write(tail);
        close();
        return;
      }

      keepAlive = setInterval(() => write(STREAM_KEEPALIVE_CHUNK), keepAliveMs);
      keepAlive.unref?.();

      const settle = (): void => {
        pending -= 1;
        if (pending === 0) {
          write(tail);
          close();
        }
      };

      for (const hole of plan.holes) {
        // One hole reveals exactly once, whichever of the three finishes first: its own promise,
        // its rejection, or its deadline. A late resolve after the deadline writes nothing —
        // the placeholder it would fill was replaced by the fallback and the document is closed.
        let revealed = false;
        // The hole's own lifetime: the response's, cut short by its deadline. The document closes
        // only once every hole settled or missed its deadline, so nothing is left to stop at close,
        // and a hole that finished keeps an un-aborted signal (`render-stream.test.ts` pins it).
        const own = new AbortController();
        const signal = AbortSignal.any([holes.signal, own.signal]);
        const reveal = (html: string, after = ''): void => {
          if (revealed) return;
          revealed = true;
          if (timer !== undefined) clearTimeout(timer);
          write(revealChunk(hole.id, html, after));
          settle();
        };
        const failed = (): string => hole.error ?? errorFallback(hole.id);
        const timer =
          timeoutMs === null
            ? undefined
            : setTimeout(() => {
                logger.warn('render.stream.hole_deadline', { hole: hole.id, timeoutMs });
                const missed = holeDeadlineMissed(hole.id, timeoutMs);
                // A client that left is nobody's fault: the abort below stopped the work on purpose.
                if (!signal.aborted) reportError(missed, { source: 'http' });
                own.abort(missed);
                // `after` on every path: the error markup may carry an island of its own.
                reveal(failed(), afterOf(hole, 'failed'));
              }, timeoutMs);
        // A response nobody is reading must not hold the process open until its deadline.
        timer?.unref?.();

        // `after` inside the chain: a throw there is this hole's failure, never an unhandled
        // rejection that holds the document to its deadline.
        void startHole(hole, signal)
          // Asked only for a reveal that will write: a hole past its deadline already answered.
          .then((html) => ({ html, after: revealed || closed ? '' : afterOf(hole, 'filled') }))
          .then(
            ({ html, after }) => {
              reveal(html, after);
            },
            (error: unknown) => {
              // `renderThrowable`, never `.message`/`String()`: the value is whatever the hole threw,
              // and a read that raises here skips the `reveal` below — the hole never fills and the
              // response is held to its deadline for a failure that was already handled.
              // A FIELD, never the message: `logger` redacts fields and never `msg`, so a hole's
              // failure text interpolated into the message reached the log past every redactor.
              logger.warn('render.stream.hole_rejected', {
                hole: hole.id,
                error: renderThrowable(error),
              });
              // Aborted means its deadline or the client already answered for it.
              if (!signal.aborted) reportError(error, { source: 'http' });
              reveal(failed(), afterOf(hole, 'failed'));
            },
          );
      }
    },

    /** The client went away. Stop enqueueing, and stop the work that was going to be enqueued. */
    cancel(reason: unknown) {
      closed = true;
      clearInterval(keepAlive);
      holes.abort(reason);
    },
  });
}

export function streamResult(plan: StreamPlan, options: StreamOptions, status = 200): RenderResult {
  return {
    status: finiteStatus('streamResult', status),
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      // Proxies that buffer defeat the entire mode.
      'x-accel-buffering': 'no',
      'transfer-encoding': 'chunked',
      [BUILD_ID_HEADER]: options.buildId,
    },
    body: renderStreamHtml(plan, options),
  };
}

/** Test/SSR-to-string helper: drain a stream into one string. */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
