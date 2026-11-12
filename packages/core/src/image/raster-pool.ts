// Single responsibility: where `transformImageBytes` runs — one lazy `raster-worker.ts` Worker,
// requests answered by id, held open only while one is pending. Where no Worker can start, inline
// on this thread, and on the web role only under `RASTER_SYNC_PIXELS`.

import { isCompiledBundle } from '../bunfs';
import { renderThrowable } from '../error-render';
import { UltimateError } from '../errors';
import { logger } from '../logger';
import { type Role, resolveRole } from '../roles';
import { errorFromWire, isRasterAnswer, isRasterReady, type RasterRequest } from './raster-wire';
import { RASTER_WORKER_DEFINE } from './raster-worker-bundle';
import { type ImageTransformSpec, transformInline } from './transform-inline';

/**
 * The most pixels the web role's event loop inflates plus deflates inline. Measured on a 4096²
 * source (2026-11-11): deflate up to 116 ms per megapixel on noisy pixels, inflate up to 58. At
 * the worse rate, 409,600 pixels (640²) is ≤ 48 ms — under the 50 ms the plan holds the loop to.
 */
export const RASTER_SYNC_PIXELS = 409_600;

export interface RasterPoolOptions {
  /** Builds the Worker. Injected by tests; one that throws is "no Worker can start here". */
  readonly spawn?: (() => Worker) | undefined;
  /** This process's role, read per inline call. Default `resolveRole()`. */
  readonly role?: (() => Role) | undefined;
}

export interface RasterPool {
  transform(bytes: Uint8Array, spec: ImageTransformSpec): Promise<Uint8Array>;
  /** Ends the Worker; the next transform starts a new one. */
  close(): void;
}

interface Pending {
  /** The CALLER's bytes, never the transferred copy: the inline fallback runs on these. */
  readonly bytes: Uint8Array;
  readonly spec: ImageTransformSpec;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Bun's `Worker` has `ref()`/`unref()`; the DOM lib type this tree compiles against declares
 * neither, so they are read off the value rather than claimed by a cast.
 */
function setHeld(worker: Worker, held: boolean): void {
  const method: unknown = Reflect.get(worker, held ? 'ref' : 'unref');
  if (typeof method === 'function') method.call(worker);
}

// Replaced with the worker's embedded path by a compile that adds `rasterWorkerBundle()`'s
// entrypoint; declared by nothing at run time, hence the `typeof` guard.
declare const ULTIMATE_RASTER_WORKER: string | undefined;

function spawnRasterWorker(): Worker {
  if (!isCompiledBundle(import.meta.dir)) {
    return new Worker(new URL('./raster-worker.ts', import.meta.url).href);
  }
  // Bundled, `import.meta.url` is the EXECUTABLE's, so the worker is found by the path its compile
  // embedded it at — and a compile that never added it has no worker to find.
  if (typeof ULTIMATE_RASTER_WORKER === 'string') return new Worker(ULTIMATE_RASTER_WORKER);
  throw new UltimateError({
    code: 'X_INTERNAL',
    cause: `this executable was compiled without the raster worker entrypoint, so ${RASTER_WORKER_DEFINE} is not defined`,
    fix: 'rasterWorkerBundle([entry])   # from @ultimat3/core: add its entrypoint beside the compile entry and merge its define (packages/core/src/image/raster-worker-bundle.ts)',
  });
}

/** Said once per pool, at warn: a process that degrades to inline must never do it silently. */
function warnInline(reason: unknown): void {
  logger.warn('image.raster_worker_unavailable', {
    reason: renderThrowable(reason),
    effect: `transforms run inline on this thread; the web role refuses a raster hop over ${RASTER_SYNC_PIXELS} pixels (X_IMAGE_RASTER_BUDGET)`,
  });
}

export function rasterPool(options: RasterPoolOptions = {}): RasterPool {
  const spawn = options.spawn ?? spawnRasterWorker;
  const roleOf = options.role ?? (() => resolveRole());
  const pending = new Map<number, Pending>();
  let worker: Worker | undefined;
  /** Set by the Worker's ready message: it LOADED, so a later death is a crash, not a missing file. */
  let loaded = false;
  let inline = false;
  let nextId = 0;

  const runInline = (bytes: Uint8Array, spec: ImageTransformSpec): Promise<Uint8Array> =>
    transformInline(bytes, spec, roleOf() === 'web' ? RASTER_SYNC_PIXELS : undefined);

  const settle = (id: number): Pending | undefined => {
    const one = pending.get(id);
    pending.delete(id);
    if (pending.size === 0 && worker !== undefined) setHeld(worker, false);
    return one;
  };

  /**
   * The Worker is gone — an uncaught error, an exit with none, or `close()` — so everything it
   * owed settles now: a promise left pending is a caller hung forever and a Worker held open.
   * Once per Worker: `gone` ignores the second of its `error` + `close` pair.
   */
  const lost = (gone: Worker, reason: string, closing: boolean): void => {
    if (worker !== gone) return;
    worker = undefined;
    const failed = [...pending.values()];
    pending.clear();
    gone.terminate();
    // Never said ready: the file could not load, so it never will — this process goes inline, and
    // what was waiting runs inline now rather than failing for a thread that was never there.
    if (!loaded && !closing) {
      inline = true;
      warnInline(reason);
      for (const one of failed) runInline(one.bytes, one.spec).then(one.resolve, one.reject);
      return;
    }
    const crash = new UltimateError({
      code: 'X_INTERNAL',
      cause: `the raster worker ended with ${failed.length} transform(s) in flight: ${reason}`,
      fix: 'bun test ./packages/core/src/image/   # reproduces the transform if it repeats; one failure alone is retried as is — the next transform starts a new worker',
    });
    for (const one of failed) one.reject(crash);
  };

  const listen = (target: Worker): void => {
    target.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isRasterReady(event.data)) {
        loaded = true;
        return;
      }
      if (!isRasterAnswer(event.data)) return;
      const one = settle(event.data.id);
      if (one === undefined) return;
      if (event.data.ok) one.resolve(event.data.bytes);
      else one.reject(errorFromWire(event.data.error));
    });
    target.addEventListener('error', (event: ErrorEvent) => lost(target, event.message, false));
    target.addEventListener('close', () => lost(target, 'it exited', false));
  };

  const started = (): Worker | undefined => {
    if (inline) return undefined;
    if (worker !== undefined) return worker;
    loaded = false;
    try {
      worker = spawn();
    } catch (error) {
      inline = true;
      warnInline(error);
      return undefined;
    }
    listen(worker);
    setHeld(worker, false);
    return worker;
  };

  return {
    transform(bytes, spec) {
      const target = started();
      if (target === undefined) return runInline(bytes, spec);
      return new Promise<Uint8Array>((resolve, reject) => {
        nextId += 1;
        // The caller keeps its bytes (`warmVariants` reuses one source), so the Worker gets a COPY
        // of the VIEW, transferred: structured-cloning it instead blocked this thread ~60 ms on a
        // 42 MB PNG (measured). `new Uint8Array(view)`, never `.slice()` — a Node `Buffer`'s slice
        // is a subarray, so transferring it detached the caller's whole parent buffer.
        const request: RasterRequest = { id: nextId, bytes: new Uint8Array(bytes), spec };
        pending.set(request.id, { bytes, spec, resolve, reject });
        // Held open only while an answer is owed: an idle Worker never keeps a process alive.
        if (pending.size === 1) setHeld(target, true);
        target.postMessage(request, [request.bytes.buffer]);
      });
    },
    close() {
      if (worker !== undefined) lost(worker, 'the pool was closed', true);
    },
  };
}

let shared: RasterPool | undefined;

/** The process's one pool, built at the first transform — nothing runs at import. */
export function rasterTransform(bytes: Uint8Array, spec: ImageTransformSpec): Promise<Uint8Array> {
  shared ??= rasterPool();
  return shared.transform(bytes, spec);
}
