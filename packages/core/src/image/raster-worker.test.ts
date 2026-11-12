// Pins the Worker entry on the main thread: importing it starts nothing, a started scope says ready,
// a request is answered by id (bytes transferred, refusals coded), and an uncloneable meta degrades.

import { describe, expect, test } from 'bun:test';
import { encodeImage } from './png-pixels';
import { blankRaster } from './raster';
import { RASTER_READY } from './raster-wire';
import { handleRasterMessage, type RasterWorkerScope, startRasterWorker } from './raster-worker';
import { transformInline } from './transform-inline';

interface Posted {
  readonly message: unknown;
  readonly transfer: readonly Transferable[];
}

function stand(failFirstPost = false): {
  readonly scope: RasterWorkerScope;
  readonly posted: Posted[];
  readonly deliver: (data: unknown) => void;
} {
  const posted: Posted[] = [];
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  let fail = failFirstPost;
  return {
    posted,
    deliver: (data) => listener?.(new MessageEvent('message', { data })),
    scope: {
      postMessage(message, options) {
        if (fail) {
          fail = false;
          throw new DOMException('meta could not be cloned', 'DataCloneError');
        }
        posted.push({ message, transfer: options?.transfer ?? [] });
      },
      addEventListener(_type, handler) {
        listener = handler;
      },
    },
  };
}

const SOURCE = encodeImage(blankRaster(30, 20));

describe('the raster Worker entry', () => {
  test('imported on the main thread, it started nothing; started, it says ready', () => {
    const { scope, posted } = stand();
    expect(posted).toEqual([]);
    startRasterWorker(scope);
    expect(posted).toEqual([{ message: RASTER_READY, transfer: [] }]);
  });

  test('answers a request by id with the inline bytes, transferred', async () => {
    const { scope, posted } = stand();
    await handleRasterMessage(scope, { id: 7, bytes: SOURCE, spec: { width: 10 } });
    const golden = await transformInline(SOURCE, { width: 10 });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.message).toEqual({ id: 7, ok: true, bytes: golden });
    expect(posted[0]?.transfer).toHaveLength(1);
  });

  test('a refusal is answered as its code, cause and fix', async () => {
    const { scope, posted } = stand();
    await handleRasterMessage(scope, { id: 3, bytes: SOURCE.subarray(0, 40), spec: {} });
    expect(posted[0]?.message).toMatchObject({
      id: 3,
      ok: false,
      error: { code: 'X_IMAGE_DECODE_FAILED' },
    });
  });

  test('a refusal whose meta cannot be cloned still arrives, without the meta', async () => {
    const { scope, posted } = stand(true);
    await handleRasterMessage(scope, { id: 4, bytes: SOURCE.subarray(0, 40), spec: {} });
    expect(posted[0]?.message).toMatchObject({ id: 4, ok: false, error: { meta: undefined } });
  });

  test('a message that is not a request is dropped, and a started scope routes requests', async () => {
    const { scope, posted, deliver } = stand();
    await handleRasterMessage(scope, { hello: true });
    expect(posted).toEqual([]);
    startRasterWorker(scope);
    deliver({ id: 9, bytes: SOURCE, spec: { width: 5 } });
    await Bun.sleep(50);
    expect(posted.map((one) => (one.message as { id?: number }).id)).toEqual([undefined, 9]);
  });
});
