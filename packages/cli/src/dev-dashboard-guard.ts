// The doors in front of `/_x` that a browser can knock on. `x dev` binds loopback, but a page the
// developer has open can still reach it: by DNS rebinding (a hostile name that resolves to
// 127.0.0.1, read back same-origin) and by a cross-site request to the SQL panel.

import { proveSameOrigin, renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { UltimateRequest } from '@ultimat3/http';
import { csrfBlocked, HttpError, json as jsonResponse, selfOrigin } from '@ultimat3/http';
import { t } from '@ultimat3/schema';
import { isLoopbackHostname } from './loopback-host';

/** A `/_x` request named a Host that is not this machine. Never echoes the Host it was sent. */
export class DevHostRefusedError extends UltimateError {
  constructor(input: { devUrl: string }) {
    super({
      code: 'X_DEV_HOST_REFUSED',
      cause:
        'a /_x request named a Host that is not localhost, a *.localhost name or a loopback address — the shape of a DNS-rebinding page reading the dev dashboard',
      fix: `curl -sS -H 'accept: application/json' ${renderFixShellArg(`${input.devUrl}/_x`, 'http://localhost:3000/_x')}`,
    });
  }
}

/** The Host as sent, else the one the URL was built from — Bun builds it from the header. */
const hostnameOf = (request: UltimateRequest): string | undefined => {
  const header = request.header('host') ?? request.url.host;
  return URL.parse(`http://${header}`)?.hostname;
};

/**
 * `421 Misdirected Request` for a Host that is not this machine, on every `/_x` route. The status
 * says "not this server", which is the truth: a rebound name was never meant to reach it.
 */
export function hostRefusal(request: UltimateRequest, devUrl: string): Response | undefined {
  const hostname = hostnameOf(request);
  if (hostname !== undefined && isLoopbackHostname(hostname)) return undefined;
  const error = new DevHostRefusedError({ devUrl });
  return jsonResponse(
    { ok: false, error: { code: error.code, cause: error.cause, fix: error.fix } },
    { status: 421 },
  );
}

/**
 * A statement runs on a POST that came from this origin — core's `proveSameOrigin`, the rule the
 * app's own writes and the sync upgrade answer to, asked HERE rather than left to the pipeline's
 * CSRF stage: an app with `csrf: { mode: 'off' }` must not switch the dev database's door off with
 * it. Neither header present is `curl`, as `checkCsrf` reads it: no page can drive that client.
 */
export function assertSameOrigin(request: UltimateRequest): void {
  const origin = request.header('origin');
  const secFetchSite = request.header('sec-fetch-site');
  if (origin === null && secFetchSite === null) return;
  const verdict = proveSameOrigin({
    selfOrigins: [selfOrigin(request.url, request.ctx.https)],
    origin,
    secFetchSite,
    listed: () => false,
    listName: 'no list — /_x admits its own origin only',
  });
  if (!verdict.ok) throw csrfBlocked(request.pathname, verdict.reason, request.ctx.ip);
}

/** The SQL panel's one input, from a form or a JSON body — `request.body` parses either. */
export const SQL_BODY = t.object({ sql: t.string });

/**
 * A statement on the query string is refused rather than run: a GET is what `<img src>` and a
 * prefetch send cross-site with nobody's consent. The fix is the POST that does run it.
 */
export const sqlOnGet = (devUrl: string): HttpError =>
  new HttpError({
    code: 'X_METHOD_NOT_ALLOWED',
    cause:
      '/_x/db runs a statement on a same-origin POST only — a GET carrying ?sql= is what a cross-site page can send',
    fix: `curl -sS -H 'accept: application/json' --data-urlencode 'sql=select 1' ${renderFixShellArg(`${devUrl}/_x/db`, 'http://localhost:3000/_x/db')}`,
  });
