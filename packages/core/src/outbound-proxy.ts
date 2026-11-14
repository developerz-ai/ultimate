// Single responsibility: which proxy one hop goes through — the request's `proxy`, or its resolver
// asked with the hop's NAMED url — validated into the `init.proxy` Bun's `fetch` takes. Asked only
// after the dial screen approved the hop: a refused host never reaches the app's resolver.

import type { OutboundSite } from './outbound-errors';
import { outboundProxyInvalid, transportText } from './outbound-errors';
import type { OutboundProxy, OutboundProxyInit, OutboundProxyTarget } from './outbound-types';

/** The schemes Bun 1.4.4's `fetch` tunnels through; `socks5:` fails at the dial (measured). */
const PROXY_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The app's resolver, raced against the hop's signal: a resolver that never answers is bounded by
 * the call's deadline like the dial is. Rejects with the signal's REASON, which the attempt codes.
 */
async function chosen(
  site: OutboundSite,
  proxy: OutboundProxy,
  target: URL,
  signal: AbortSignal,
): Promise<OutboundProxyTarget | undefined> {
  if (typeof proxy !== 'function') return proxy;
  if (signal.aborted) throw signal.reason;
  let stop = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // A copy: the resolver is the app's, and the hop's URL is still read after it returns.
  const asked = Promise.resolve()
    .then(() => proxy(new URL(target.href)))
    .catch((error: unknown) => {
      throw outboundProxyInvalid(site, `the proxy resolver threw (${transportText(error)})`, error);
    });
  try {
    return await Promise.race([asked, aborted]);
  } finally {
    stop();
    // The loser is never unhandled: a resolver failing after the deadline is nobody's answer.
    asked.catch(() => undefined);
    aborted.catch(() => undefined);
  }
}

/** The hop's `init.proxy`, or `undefined` to dial it direct. Throws `X_OUTBOUND_PROXY_INVALID`. */
export async function proxyFor(
  site: OutboundSite,
  proxy: OutboundProxy | undefined,
  target: URL,
  signal: AbortSignal,
): Promise<OutboundProxyInit | undefined> {
  if (proxy === undefined) return undefined;
  const picked = await chosen(site, proxy, target, signal);
  if (picked === undefined) return undefined;
  const plain = typeof picked === 'string' || picked instanceof URL;
  const raw = plain ? picked : picked.url;
  const headers = plain ? undefined : picked.headers;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw outboundProxyInvalid(site, 'the proxy is not an absolute URL');
  }
  if (!PROXY_SCHEMES.has(url.protocol)) {
    throw outboundProxyInvalid(
      site,
      `the proxy's scheme is ${url.protocol}, and fetch tunnels through http: and https: proxies only`,
    );
  }
  return { url: url.href, ...(headers === undefined ? {} : { headers: { ...headers } }) };
}
