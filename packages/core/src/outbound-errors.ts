// Single responsibility: the twelve refusals `outbound()` can end on, each built from the call's
// redacted label. Never a query string, never a header: a cause reaches a log store and a
// problem document, and a signed URL's query is the credential.

import { registerErrorCodes } from './error-codes';
import { renderFixShellArg, renderThrowable } from './error-render';
import { registerErrorRetry } from './error-retry';
import { UltimateError } from './errors';
import { replaceUrlUserinfo } from './url-userinfo';

/**
 * The twelve codes' retry classes, registered HERE and not in `error-retry.ts`'s core table: that
 * table rides every browser page, and these are server-only (axiom 6). The transport faults are
 * retryable, a stated delay is `retry-after`, and every answer the same request gets again is
 * terminal — unclassified, `retry()` would replay a 401 three times.
 */
registerErrorRetry({
  X_OUTBOUND_TIMEOUT: 'retryable',
  X_OUTBOUND_UNREACHABLE: 'retryable',
  X_OUTBOUND_UNAVAILABLE: 'retryable',
  X_OUTBOUND_THROTTLED: 'retry-after',
  X_OUTBOUND_REFUSED: 'terminal',
  X_OUTBOUND_TOO_LARGE: 'terminal',
  X_OUTBOUND_HOST_BLOCKED: 'terminal',
  X_OUTBOUND_REDIRECTED: 'terminal',
  X_OUTBOUND_TRANSPORT_REDIRECTED: 'terminal',
  X_OUTBOUND_RETRY_UNSAFE: 'terminal',
  X_OUTBOUND_BODY_INVALID: 'terminal',
  X_OUTBOUND_PROXY_INVALID: 'terminal',
});

/**
 * Registered here, not in `core-error-codes.ts`: that table rides every browser page, and only
 * this server-only module throws it — the code and the module that throws it ship together.
 */
registerErrorCodes({
  X_OUTBOUND_TRANSPORT_REDIRECTED: { title: 'an outbound transport followed a redirect itself' },
});

/** What a failure may say about the call: who, how, and where, never the query or a header. */
export interface OutboundSite {
  readonly vendor: string;
  readonly method: string;
  readonly origin: string;
  readonly path: string;
}

/** `resend POST https://api.resend.com/emails` — the one spelling every cause opens with. */
export const siteLabel = (site: OutboundSite): string =>
  `${site.vendor} ${site.method} ${site.origin}${site.path}`;

const siteMeta = (site: OutboundSite): Readonly<Record<string, string>> => ({
  vendor: site.vendor,
  method: site.method,
  origin: site.origin,
  path: site.path,
});

/** Which bound ran out: the whole call's `deadlineMs`, or a body that went quiet for `idleMs`. */
export type OutboundTimeoutPhase = 'deadline' | 'idle';

export function outboundTimeout(
  site: OutboundSite,
  phase: OutboundTimeoutPhase,
  boundMs: number,
): UltimateError {
  const bound = phase === 'deadline' ? 'deadlineMs' : 'idleMs';
  const what =
    phase === 'deadline'
      ? `did not finish within its deadline of ${String(boundMs)} ms, retries and waits included`
      : `sent no body bytes for ${String(boundMs)} ms`;
  return new UltimateError({
    code: 'X_OUTBOUND_TIMEOUT',
    cause: `${siteLabel(site)} ${what}`,
    fix: `outbound({ url, vendor: '${site.vendor}', dial, ${bound}: ${String(boundMs * 2)} })   # raise ${bound} on this call, or check the vendor's latency`,
    meta: { ...siteMeta(site), phase, [bound]: boundMs },
  });
}

/**
 * A transport failure in its own words with every URL's userinfo cut (`//…@`) and every query
 * string cut (`?…`): a runtime's message may quote the URL it was dialling, a proxy URL keeps its
 * credential before the LAST `@` (`replaceUrlUserinfo`), and a signed URL keeps it in the query.
 * Userinfo first: a `?` the query cut stops at would otherwise end an authority early.
 */
export const transportText = (error: unknown): string =>
  replaceUrlUserinfo(renderThrowable(error), () => '…').replaceAll(/\?[^\s"'`)]*/g, '?…');

/** The refusals that say the CALLER's bound ran out, not the vendor: a breaker hears nothing. */
const CALLER_BOUND = new WeakSet<UltimateError>();

/** Whether `error` is `callerDeadline`'s: the caller's time ran out, nothing about the vendor. */
export const isCallerBound = (error: unknown): boolean =>
  error instanceof UltimateError && CALLER_BOUND.has(error);

/**
 * The AMBIENT deadline was the binding bound and it ran out — the request's or a `bound`'s, never
 * `deadlineMs`. Core's `X_TIMEOUT`, the code the caller's own deadline already answers with.
 */
export function callerDeadline(site: OutboundSite): UltimateError {
  const error = new UltimateError({
    code: 'X_TIMEOUT',
    cause: `the caller's own deadline ran out before ${siteLabel(site)} answered; its deadlineMs was not the bound that fired`,
    fix: 'configureHttp({ requestTimeoutMs: 60_000 })   # at module scope in a file under apps/*/, if the request deadline is the one that is too short for this vendor',
    meta: { ...siteMeta(site), bound: 'caller' },
  });
  CALLER_BOUND.add(error);
  return error;
}

export function outboundUnreachable(site: OutboundSite, error: unknown): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_UNREACHABLE',
    cause: `${siteLabel(site)} got no response: ${transportText(error)}`,
    fix: `curl -sS -m 5 -o /dev/null ${renderFixShellArg(site.origin, '<vendor origin>')}   # reachable from here? else check the egress rule and ${site.vendor}'s status, then re-run the call`,
    meta: siteMeta(site),
    sourceError: error,
  });
}

/** `meta.fields` only when the caller's refusal schema answered: absent, never `undefined`. */
const fieldsMeta = (fields: unknown): { readonly fields?: unknown } =>
  fields === undefined ? {} : { fields };

/** `meta.headers` only when the caller's `refusal.headers` asked: absent, never `undefined`. */
const headersMeta = (
  headers: Readonly<Record<string, string>> | undefined,
): { readonly headers?: Readonly<Record<string, string>> } =>
  headers === undefined ? {} : { headers };

export function outboundThrottled(
  site: OutboundSite,
  status: number,
  retryAfterSeconds: number,
  detail = '',
  fields?: unknown,
  headers?: Readonly<Record<string, string>>,
): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_THROTTLED',
    cause: `${siteLabel(site)} answered ${String(status)} and asked to wait ${String(retryAfterSeconds)} s`,
    fix: `await Bun.sleep(${String(retryAfterSeconds * 1000)})   # then call ${site.vendor} again, or lower the call rate at the site that calls outbound()`,
    meta: {
      ...siteMeta(site),
      status,
      retryAfterSeconds,
      detail,
      ...fieldsMeta(fields),
      ...headersMeta(headers),
    },
  });
}

export function outboundUnavailable(
  site: OutboundSite,
  status: number,
  detail = '',
  fields?: unknown,
  headers?: Readonly<Record<string, string>>,
): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_UNAVAILABLE',
    cause: `${siteLabel(site)} answered ${String(status)} on every attempt: the vendor's fault, not the request's`,
    fix: `curl -sS -m 5 -o /dev/null -w '%{http_code}\\n' ${renderFixShellArg(site.origin, '<vendor origin>')}   # the vendor's fault: re-run the call; if ${String(status)} persists, check ${site.vendor}'s status page`,
    meta: { ...siteMeta(site), status, detail, ...fieldsMeta(fields), ...headersMeta(headers) },
  });
}

export function outboundRefused(
  site: OutboundSite,
  status: number,
  detail: string,
  fields?: unknown,
  headers?: Readonly<Record<string, string>>,
): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_REFUSED',
    cause: `${siteLabel(site)} answered ${String(status)}, and the same request will get it again`,
    fix:
      status === 401
        ? `outbound({ url, vendor: '${site.vendor}', headers: { authorization } })   # with a refreshed credential, then call again`
        : `outbound({ url, vendor: '${site.vendor}', body })   # with the request fixed from meta.detail and meta.status`,
    meta: { ...siteMeta(site), status, detail, ...fieldsMeta(fields), ...headersMeta(headers) },
  });
}

export function outboundTooLarge(site: OutboundSite, maxBytes: number): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_TOO_LARGE',
    cause: `${siteLabel(site)} answered more than ${String(maxBytes)} bytes; the read stopped at the cap`,
    fix: `outbound({ url, vendor: '${site.vendor}', dial, deadlineMs, maxBytes: ${String(maxBytes * 4)} })   # or read: 'stream' to consume it in chunks`,
    meta: { ...siteMeta(site), maxBytes },
  });
}

export function outboundHostBlocked(site: OutboundSite, reason: string): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_HOST_BLOCKED',
    cause: `${siteLabel(site)} was refused before dialling: ${reason}`,
    fix: `outbound({ url, vendor: '${site.vendor}', dial: 'named' })   # for a host this app names in code; otherwise give it a public https:// URL`,
    meta: { ...siteMeta(site), reason },
  });
}

export function outboundRedirected(
  site: OutboundSite,
  status: number,
  location: string,
): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_REDIRECTED',
    cause: `${siteLabel(site)} answered ${String(status)} towards ${location}, and redirects are not followed by default`,
    fix: `outbound({ url, vendor: '${site.vendor}', redirect: 'follow' })   # or call the Location the cause names directly`,
    meta: { ...siteMeta(site), status, location },
  });
}

/**
 * The app's transport (`deps.fetch`) followed a hop itself: no screen saw it, so its answer is not
 * the vendor's to trust. No `status` in `meta`, so `outboundResponse()` never rebuilds it as that 2xx.
 */
export function outboundTransportRedirected(site: OutboundSite, reached: string): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_TRANSPORT_REDIRECTED',
    cause: `${siteLabel(site)}: the transport passed as deps.fetch followed a redirect itself, towards ${reached}, ignoring init.redirect ('manual')`,
    fix: `fetch(url, init)   # in the transport given to outbound(): pass init through unchanged, and let outbound({ url, vendor: '${site.vendor}', redirect: 'follow' }) take each hop`,
    meta: { ...siteMeta(site), location: reached },
  });
}

export function outboundRetryUnsafe(site: OutboundSite): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_RETRY_UNSAFE',
    cause: `${siteLabel(site)} was given a retry policy, and a ${site.method} replayed is a second write`,
    fix: `outbound({ url, vendor, dial, deadlineMs, method: '${site.method}', body })   # remove retry from this write`,
    meta: siteMeta(site),
  });
}

export function outboundBodyInvalid(site: OutboundSite, issues: readonly string[]): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_BODY_INVALID',
    cause: `${siteLabel(site)} answered a body its schema refused at ${issues.join(', ') || 'the root'}`,
    fix: `answer.json(schema)   # edit that schema for ${site.vendor}, or ask the vendor whether the response changed`,
    meta: { ...siteMeta(site), issues },
  });
}

/**
 * The proxy a hop was given cannot be used: not a URL, a scheme Bun's `fetch` does not tunnel
 * through, or a resolver that threw. `reason` names the shape and the scheme, never the URL: a
 * proxy URL carries its credential.
 */
export function outboundProxyInvalid(
  site: OutboundSite,
  reason: string,
  error?: unknown,
): UltimateError {
  return new UltimateError({
    code: 'X_OUTBOUND_PROXY_INVALID',
    cause: `${siteLabel(site)} was refused before dialling: ${reason}`,
    fix: `outbound({ url, vendor: '${site.vendor}', dial, proxy: 'http://<user>:<password>@<proxy-host>:<port>' })   # an http: or https: proxy URL, or a resolver answering one (or undefined to dial direct)`,
    meta: { ...siteMeta(site), reason },
    ...(error === undefined ? {} : { sourceError: error }),
  });
}
