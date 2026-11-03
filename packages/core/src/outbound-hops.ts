// Single responsibility: one attempt's hops — dial the URL as `dial` says (screened and pinned, or
// as named), and under `redirect: 'follow'` take each 3xx by hand, re-screening the next address
// and dropping credentials at an origin change. The platform's own `follow` dials a hop itself,
// unscreened: measured, a default redirect from a screened name reached loopback.

import type { DialResolve } from './outbound-dial';
import { publicUrlRefusal, screenDial } from './outbound-dial';
import type { OutboundSite } from './outbound-errors';
import { outboundHostBlocked, outboundRedirected, outboundUnreachable } from './outbound-errors';
import type { OutboundBody, OutboundFetch, OutboundInit } from './outbound-types';
import { OUTBOUND_MAX_REDIRECTS } from './outbound-types';

export interface HopCall {
  readonly site: OutboundSite;
  readonly url: URL;
  readonly method: string;
  /** As the caller spelled them; every rule below compares names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: OutboundBody | undefined;
  readonly dial: 'named' | 'public';
  readonly redirect: 'error' | 'follow';
  readonly local: boolean;
  readonly fetch: OutboundFetch;
  readonly resolve: DialResolve | undefined;
}

/**
 * What a hop to ANOTHER origin may carry: an allow-list, never a strip-list. The fetch standard
 * strips `authorization` and `cookie`, but a vendor's own credential header (`x-api-key`) went
 * along to `http://169.254.169.254` in a probe — so everything else is dropped.
 */
const CROSS_ORIGIN_KEPT: ReadonlySet<string> = new Set(['accept', 'content-type', 'user-agent']);

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * A path as a cause, `meta` or a log line may show it: the first segment, then only how long the
 * rest is. A webhook URL keeps its credential IN the path (`/services/T000/B000/XXXX`).
 */
export function redactedPath(pathname: string): string {
  const [first = '', ...rest] = pathname.split('/').filter((segment) => segment !== '');
  if (rest.length === 0) return `/${first}`;
  return `/${first}/…(${String(rest.join('/').length)} chars)`;
}

/** Where a URL points, for a cause or `meta`: origin and the redacted path, never the query. */
export const redactedUrl = (url: URL): string => `${url.origin}${redactedPath(url.pathname)}`;

interface Target {
  readonly url: string;
  readonly host?: string | undefined;
  readonly serverName?: string | undefined;
}

/**
 * The first hop as `dial` says; EVERY later hop screened as a public one, `'named'` included: the
 * app named the first host, never the one a redirect points at.
 */
async function targetFor(call: HopCall, url: URL, hop: number): Promise<Target> {
  if (call.dial === 'named' && hop === 0) return { url: url.href };
  const refusal = publicUrlRefusal(url, call.local);
  if (refusal !== undefined)
    throw outboundHostBlocked(call.site, `${redactedUrl(url)}: ${refusal}`);
  const verdict = await screenDial(url, { resolve: call.resolve });
  if ('refused' in verdict) {
    throw outboundHostBlocked(
      call.site,
      `${url.host} resolves to a ${verdict.refused} address, and a public dial opens only public ones`,
    );
  }
  if ('unresolved' in verdict)
    throw outboundUnreachable(call.site, verdict.error ?? verdict.unresolved);
  return verdict.pin;
}

const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // A redirect's body is nothing the caller waits for; its cancel failing is no failure.
  }
};

/** The response the last hop answered. A 3xx comes back as itself under `redirect: 'error'`. */
export async function sendHops(call: HopCall, signal: AbortSignal): Promise<Response> {
  let url = call.url;
  let method = call.method;
  let body = call.body;
  let headers: Record<string, string> = { ...call.headers };
  for (let hop = 0; ; hop += 1) {
    const target = await targetFor(call, url, hop);
    const init: OutboundInit = {
      method,
      // Last: a pinned request is reached AS the name that was screened.
      headers:
        target.host === undefined
          ? headers
          : {
              ...Object.fromEntries(
                Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host'),
              ),
              host: target.host,
            },
      ...(body === undefined ? {} : { body }),
      ...(target.serverName === undefined ? {} : { tls: { serverName: target.serverName } }),
      signal,
      redirect: 'manual',
    };
    const response = await call.fetch(target.url, init);
    const location = response.headers.get('location');
    if (!isRedirect(response.status) || location === null || call.redirect === 'error') {
      return response;
    }
    await discard(response);
    const next = new URL(location, url);
    if (hop + 1 > OUTBOUND_MAX_REDIRECTS) {
      throw outboundRedirected(call.site, response.status, redactedUrl(next));
    }
    if (next.origin !== url.origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => CROSS_ORIGIN_KEPT.has(name.toLowerCase())),
      );
    }
    // 303 always, and 301/302 on a POST: the fetch standard re-sends as a GET with no body.
    if (response.status === 303 || (method === 'POST' && response.status <= 302)) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
      );
    }
    url = next;
  }
}
