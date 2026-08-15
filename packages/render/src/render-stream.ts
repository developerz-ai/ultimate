/**
 * `stream` — the default for `app/` pages. A genuinely static shell is flushed on the
 * first tick; every `<Suspense>` boundary becomes a hole that is filled out of order, in
 * completion order, as its data resolves.
 *
 * Why the shell is free here: Solid compiles templates to DOM operations and tracks
 * updates with signals, so there is no VDOM tree to replay and no hydration pass over the
 * shell. A resolved hole patches the exact nodes bound to it; the surrounding markup is
 * never re-executed. In a VDOM framework a streamed shell still pays to hydrate the whole
 * tree, which buys TTFB but not TBT — here it buys both, so a `<Suspense>` boundary that
 * contains no interactive island costs literally zero JS.
 */

import { logger } from '@ultimat3/core';
import type { RenderResult } from './route';

export interface StreamHole {
  /** Stable within a response; becomes the DOM id, so keep it short. */
  readonly id: string;
  /** Rendered synchronously into the first flush (the `<Suspense fallback>`). */
  readonly fallback: string;
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

/** The placeholder that sits in the first flush, holding the fallback markup. */
export function holeMarker(id: string, fallback: string): string {
  return `<x-hole id="${holeId(id)}">${fallback}</x-hole>`;
}

/**
 * The entire client half of out-of-order streaming. Inline, uncompressed, ~200 bytes; it
 * moves a late `<template>`'s content into the placeholder that is already on screen.
 */
export const REVEAL_SCRIPT =
  "<script>window.$X=function(i){var t=document.querySelector('template[data-x-hole=\"'+i+'\"]')," +
  's=document.getElementById(i);if(t&&s){s.replaceWith(t.content);t.remove()}}</script>';

export function revealChunk(id: string, html: string): string {
  const key = holeId(id);
  return `<template data-x-hole="${key}">${html}</template><script>$X("${key}")</script>`;
}

export interface StreamOptions {
  readonly buildId: string;
  /** Rendered into a hole whose promise rejected. Keep it a token-styled inline block. */
  readonly errorFallback?: (holeId: string) => string;
}

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
    options.errorFallback ?? ((id) => `<div data-x-hole-error="${id}" hidden></div>`);
  /**
   * The response's own lifetime. A client that disconnects mid-stream cancels the stream, and
   * both halves of that have to be honoured: nothing more may be enqueued — `settle`'s
   * `write(tail)`/`close()` on a cancelled controller threw out of a `void`ed promise, one
   * unhandled rejection per response — and the holes still running must be told to stop doing
   * their database work for a document nobody will read.
   */
  const holes = new AbortController();
  let closed = false;

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

      const settle = (): void => {
        pending -= 1;
        if (pending === 0) {
          write(tail);
          close();
        }
      };

      for (const hole of plan.holes) {
        void hole
          .resolve(holes.signal)
          .then(
            (html) => {
              write(revealChunk(hole.id, html));
            },
            (error: unknown) => {
              logger.warn(
                `stream hole ${hole.id} rejected: ${error instanceof Error ? error.message : String(error)}`,
              );
              write(revealChunk(hole.id, errorFallback(hole.id)));
            },
          )
          .then(settle, settle);
      }
    },

    /** The client went away. Stop enqueueing, and stop the work that was going to be enqueued. */
    cancel(reason: unknown) {
      closed = true;
      holes.abort(reason);
    },
  });
}

export function streamResult(plan: StreamPlan, options: StreamOptions, status = 200): RenderResult {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      // Proxies that buffer defeat the entire mode.
      'x-accel-buffering': 'no',
      'transfer-encoding': 'chunked',
      'x-ultimate-build': options.buildId,
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
