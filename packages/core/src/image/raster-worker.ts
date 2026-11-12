// Single responsibility: the raster Worker's entry — one `transformInline` per request, answered by
// id. Its own thread, so the inflate and deflate in `png-pixels.ts` block nobody's event loop.
// Loaded by `raster-pool.ts` through `new Worker(url)`; starts itself only off the main thread, so a
// test imports it and drives `startRasterWorker` with a stand-in scope.

import { isRasterRequest, RASTER_READY, type RasterAnswer, wireError } from './raster-wire';
import { transformInline } from './transform-inline';

/** The two globals a Worker talks through — the real `self`, or a test's stand-in. */
export interface RasterWorkerScope {
  postMessage(message: unknown, options?: { readonly transfer?: Transferable[] }): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

function answer(scope: RasterWorkerScope, message: RasterAnswer, transfer: Transferable[]): void {
  try {
    scope.postMessage(message, { transfer });
  } catch (error) {
    // A `meta` that cannot be cloned loses only itself: the code, cause and fix still arrive.
    if (message.ok) throw error;
    scope.postMessage({ ...message, error: { ...message.error, meta: undefined } });
  }
}

/** One request, one answer. Anything that is not a request has no id to answer, so it is dropped. */
export async function handleRasterMessage(scope: RasterWorkerScope, data: unknown): Promise<void> {
  if (!isRasterRequest(data)) return;
  try {
    const bytes = await transformInline(data.bytes, data.spec);
    // Transferred, not copied: these bytes are the worker's own, and the copy would be on the
    // receiving thread — the one this file exists to keep free.
    answer(scope, { id: data.id, ok: true, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    answer(scope, { id: data.id, ok: false, error: wireError(error) }, []);
  }
}

/** Listens, then says ready — the pool counts a Worker as LOADED from that message on. */
export function startRasterWorker(scope: RasterWorkerScope): void {
  scope.addEventListener('message', (event) => {
    void handleRasterMessage(scope, event.data);
  });
  scope.postMessage(RASTER_READY);
}

if (!Bun.isMainThread) startRasterWorker(globalThis);
