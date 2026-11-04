// The read half of `assets.retain`: an asset route that missed asks the retained disk, and the disk
// answers only a URL a retained build's manifest names — the manifest is the one gate, so no route
// restates a URL shape. Composed over the web boot's routes by `serve-web.ts`; `x dev` never is.

import type { Clock } from '@ultimat3/core';
import { finiteCount, logger, renderThrowable, systemClock } from '@ultimat3/core';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { objectResponse } from '@ultimat3/http';
import type { StorageObject } from '@ultimat3/storage';
import type { RetainedScope } from './retained-assets-layout';
import { readManifests, retainedFileKey } from './retained-assets-layout';

/**
 * How often an unnamed URL may make the reader list the manifests again. A new build's pods
 * publish after this one booted, and its URLs must become readable here (a new document reaching
 * an old pod); a URL nobody ever published must not cost a listing per request.
 */
export const RETAINED_REFRESH_MS = 5_000;

/** What `serve-web.ts` hands the routes: the retained answer for a request, or none. */
export interface RetainedAssets {
  read(request: UltimateRequest): Promise<Response | undefined>;
}

export interface RetainedAssetsOptions extends RetainedScope {
  readonly clock?: Clock | undefined;
  readonly refreshMs?: number | undefined;
}

/** A body whose first chunk has arrived, or a throw: what was swept since `stat` is a miss. */
async function startedBody(
  body: ReadableStream<Uint8Array>,
): Promise<{ readonly stream: ReadableStream<Uint8Array>; readonly cancel: () => void }> {
  const reader = body.getReader();
  const first = await reader.read();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { stream, cancel: () => void reader.cancel().catch(() => undefined) };
}

export function retainedAssets(options: RetainedAssetsOptions): RetainedAssets {
  const clock = options.clock ?? systemClock;
  const refreshMs = finiteCount(
    'retainedAssets',
    'refreshMs',
    options.refreshMs ?? RETAINED_REFRESH_MS,
  );
  let named: ReadonlySet<string> = new Set();
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    refreshing ??= (async () => {
      refreshedAt = clock.now().getTime();
      const manifests = await readManifests(options);
      // A manifest that does not parse leaves the last good set: never serve on a guess.
      if (manifests !== undefined) {
        named = new Set(manifests.flatMap(({ manifest }) => manifest.urls));
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  const isNamed = async (pathname: string): Promise<boolean> => {
    if (named.has(pathname)) return true;
    if (clock.now().getTime() - refreshedAt < refreshMs) return false;
    await refresh();
    return named.has(pathname);
  };

  return {
    async read(request: UltimateRequest): Promise<Response | undefined> {
      const { pathname } = request;
      try {
        if (!(await isNamed(pathname))) return undefined;
        const key = retainedFileKey(options.prefix, pathname);
        const object: StorageObject | undefined = await options.disk.stat(key);
        if (object === undefined) return undefined;
        const body = await startedBody(await options.disk.stream(key));
        let sent = false;
        const response = await objectResponse(
          request,
          {
            object,
            open: (range) => {
              if (range === undefined) {
                sent = true;
                return body.stream;
              }
              return options.disk.streamRange(key, [range.start, range.end]);
            },
          },
          // `{}`, not the stored-object sandbox: these are the app's own scripts and stylesheets,
          // and an `attachment` disposition would make a browser refuse to run them.
          { cache: { mode: 'immutable' }, headers: {} },
        );
        if (!sent) body.cancel();
        return response;
      } catch (error) {
        // A disk that cannot answer is a miss: the route's own 404 is still true for this process.
        logger.warn('assets.retain_read_failed', { pathname, cause: renderThrowable(error) });
        return undefined;
      }
    },
  };
}

/**
 * Every `GET` route tagged `assets` asks `retained` when it would answer 404. Over the composed
 * table rather than inside each factory, so the routes `x dev` mounts are byte-for-byte the
 * container's and no factory gains a second way to answer.
 */
export function withRetainedAssets(
  routes: readonly Route[],
  retained: RetainedAssets | undefined,
): readonly Route[] {
  if (retained === undefined) return routes;
  return routes.map((route) =>
    route.method !== 'GET' || !(route.meta?.tags ?? []).includes('assets')
      ? route
      : {
          ...route,
          handler: async (request, ctx) => {
            const answer = await route.handler(request, ctx);
            if (answer.status !== 404) return answer;
            return (await retained.read(request)) ?? answer;
          },
        },
  );
}
