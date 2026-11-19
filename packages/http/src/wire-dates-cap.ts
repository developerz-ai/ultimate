// Single responsibility: the size limit on an answer's `x-ultimate-dates` value. A header is not a
// body: a proxy buffers the whole header block (nginx's default `proxy_buffer_size` is one page,
// 4 KB or 8 KB), so an answer that needs one path per instant is sent with none, never a 502.

import { type Ctx, logger, tryUseContext, wireDatePaths } from '@ultimat3/core';
import { requestBehind } from './context';

/**
 * The longest `x-ultimate-dates` value sent, in bytes (the value is URI-encoded, so ASCII). The
 * smallest default a reverse proxy gives an upstream's WHOLE header block is 4 KB, and this value
 * shares it with the status line and every other header: the framework's own block (security
 * headers, CSP, CORS, rate-limit, trace ids, one sealed cookie) measures ~2 KB, so 1.5 KB here
 * leaves ~0.5 KB for an app's own (`wire-dates-cap.test.ts` measures it).
 */
export const WIRE_DATES_MAX_BYTES = 1_536;

/** Operations already warned about. Bounded by the route table; the ceiling is the belt. */
const warned = new Set<string>();
const MAX_OPERATIONS = 4_096;
const NO_REQUEST = 'outside a request';

const warnOnce = (value: string, ctx: Ctx | undefined): void => {
  const operation = requestBehind(ctx)?.route?.meta.name ?? NO_REQUEST;
  if (warned.has(operation)) return;
  if (warned.size >= MAX_OPERATIONS) warned.clear();
  warned.add(operation);
  // `wireDatePaths` wrote this value a line ago, so it parses; counted once per operation.
  const paths = (JSON.parse(decodeURIComponent(value)) as readonly unknown[]).length;
  (ctx?.logger ?? logger).warn('http.wire_dates_dropped', {
    operation,
    paths,
    bytes: value.length,
    maxBytes: WIRE_DATES_MAX_BYTES,
  });
};

/**
 * The `x-ultimate-dates` value for `data` (core's `wireDatePaths`), or `undefined` when it holds
 * no instant OR the value is past `WIRE_DATES_MAX_BYTES`. Past the cap there is no partial list:
 * the client reads every instant as the ISO string the body always held, and the operation — the
 * route's name, read off the request behind `ctx` — is logged ONCE at `warn` with the path count.
 * The one function an answer's header and a streamed frame's `dates:` line are both written from.
 */
export const cappedWireDates = (
  data: unknown,
  ctx: Ctx | undefined = tryUseContext(),
): string | undefined => {
  const value = wireDatePaths(data);
  if (value === undefined || value.length <= WIRE_DATES_MAX_BYTES) return value;
  warnOnce(value, ctx);
  return undefined;
};

/** TEST SEAM: forget which operations were warned about. */
export const resetWireDatesCap = (): void => {
  warned.clear();
};
