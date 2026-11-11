// Single responsibility: the raster Worker's entry — one `transformInline` per request, answered by
// id. Its own thread, so the inflate and deflate in `png-pixels.ts` block nobody's event loop.
// Loaded by `raster-pool.ts` through `new Worker(url)`; never imported.

import { isRasterRequest, RASTER_READY, type RasterAnswer, wireError } from './raster-wire';
import { transformInline } from './transform-inline';

function answer(message: RasterAnswer, transfer: Transferable[] = []): void {
  try {
    postMessage(message, { transfer });
  } catch (error) {
    // A `meta` that cannot be cloned loses only itself: the code, cause and fix still arrive.
    if (message.ok) throw error;
    postMessage({ ...message, error: { ...message.error, meta: undefined } });
  }
}

async function transform(data: unknown): Promise<void> {
  // Nothing to answer without an id; the pool only ever sends requests, so this is unreachable.
  if (!isRasterRequest(data)) return;
  try {
    const bytes = await transformInline(data.bytes, data.spec);
    // Transferred, not copied: these bytes are the worker's own, and the copy would be on the
    // receiving thread — the one this file exists to keep free.
    answer({ id: data.id, ok: true, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    answer({ id: data.id, ok: false, error: wireError(error) });
  }
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  void transform(event.data);
});

// Last, after the listener: the pool counts a Worker as LOADED from this message on.
postMessage(RASTER_READY);
