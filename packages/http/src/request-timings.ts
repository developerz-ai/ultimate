// Single responsibility: where one request's time went — the stages before the handler, the
// handler, and the statements, renders and cache lookups it caused — read by the `Server-Timing`
// breakdown (`x dev`) and the `http.request.slow` line. One accumulator, two readers, so the header
// a developer saw and the line production wrote can never disagree about a request.

import { subscribe, tryUseContext } from '@ultimat3/core';

/** Every number a request's breakdown carries. Milliseconds, rounded to hundredths. */
export interface RequestTimings {
  /** The request stages before the handler: admit, context, auth, rate-limit, csrf, body, authz. */
  readonly gateMs: number | undefined;
  /** The route handler, middleware included. `undefined` when a refusal ended the request first. */
  readonly handlerMs: number | undefined;
  readonly dbStatements: number;
  readonly dbMs: number;
  readonly renderMs: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Keyed by the request's context object — the one `asCtx` publishes through core's ALS, so a
 * subscriber hearing a statement on the request's stack finds it with `tryUseContext()`. A
 * `WeakMap`, so a record lives exactly as long as its request, with no sweep and no cap to tune.
 */
const byContext = new WeakMap<object, Mutable<RequestTimings>>();

const round = (ms: number): number => Math.round(ms * 100) / 100;

const recordOf = (ctx: object): Mutable<RequestTimings> => {
  const known = byContext.get(ctx);
  if (known !== undefined) return known;
  const fresh: Mutable<RequestTimings> = {
    gateMs: undefined,
    handlerMs: undefined,
    dbStatements: 0,
    dbMs: 0,
    renderMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  byContext.set(ctx, fresh);
  return fresh;
};

/** The request this event was emitted inside, or nothing — a job or a boot statement has none. */
const current = (): Mutable<RequestTimings> | undefined => {
  const ctx = tryUseContext();
  return ctx === undefined ? undefined : recordOf(ctx);
};

/**
 * Hear `db.statement`, `render.page` and `cache.hit`/`cache.miss` for whichever request emitted
 * them. Returns the unsubscribe. The boot installs it ONCE beside `subscribeSemconvMetrics()` and
 * releases it on stop, as every other subscriber is: without it the breakdown carries the gate and
 * handler split and no statement counts.
 */
export function subscribeRequestTimings(): () => void {
  const offs = [
    subscribe('db.statement', (event) => {
      const record = current();
      if (record === undefined) return;
      record.dbStatements += 1;
      record.dbMs += event.payload.durationMs;
    }),
    subscribe('render.page', (event) => {
      const record = current();
      if (record !== undefined) record.renderMs += event.payload.durationMs;
    }),
    subscribe('cache', (event) => {
      if (event.name !== 'cache.hit' && event.name !== 'cache.miss') return;
      const record = current();
      if (record === undefined) return;
      if (event.name === 'cache.hit') record.cacheHits += 1;
      else record.cacheMisses += 1;
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** The handler's share, noted by the `handler` stage once it settles. */
export const noteHandlerTimings = (ctx: object, gateMs: number, handlerMs: number): void => {
  const record = recordOf(ctx);
  record.gateMs = round(gateMs);
  record.handlerMs = round(handlerMs);
};

/** What was noted for this request, or `undefined` when nothing was. */
export const requestTimings = (ctx: object): RequestTimings | undefined => {
  const record = byContext.get(ctx);
  if (record === undefined) return undefined;
  return { ...record, dbMs: round(record.dbMs), renderMs: round(record.renderMs) };
};

/**
 * The `Server-Timing` value. The breakdown only when asked — under `x dev` — because each entry
 * is a measurement of this server's internals handed to whoever made the request: how long a
 * query ran is a timing oracle on data the caller cannot read. `total` alone is what the public gets.
 */
export const serverTimingValue = (
  totalMs: number,
  timings: RequestTimings | undefined,
  breakdown: boolean,
): string => {
  const total = `total;dur=${String(totalMs)}`;
  if (!breakdown || timings === undefined) return total;
  const entries = [total];
  if (timings.gateMs !== undefined) entries.push(`gate;dur=${String(timings.gateMs)}`);
  if (timings.handlerMs !== undefined) entries.push(`handler;dur=${String(timings.handlerMs)}`);
  if (timings.dbStatements > 0) {
    entries.push(
      `db;dur=${String(timings.dbMs)};desc="${String(timings.dbStatements)} statements"`,
    );
  }
  if (timings.renderMs > 0) entries.push(`render;dur=${String(timings.renderMs)}`);
  if (timings.cacheHits + timings.cacheMisses > 0) {
    entries.push(
      `cache;desc="${String(timings.cacheHits)} hit, ${String(timings.cacheMisses)} miss"`,
    );
  }
  return entries.join(', ');
};
