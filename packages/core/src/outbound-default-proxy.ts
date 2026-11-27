// Single responsibility: the app-wide egress proxy — `outbound.proxy` in `app.config.ts`, set once
// by the boot — as the resolver every `outbound()` call with no `proxy` of its own is handed.
// Loopback and the app's `direct` hosts never take it: an in-cluster collector or sidecar is not
// egress. A raw transport asks `ambientProxyFor`. Which proxy stays the app's; this carries it.

import { classifyAddress } from './address-class';
import { logger } from './logger';
import type { OutboundProxy } from './outbound-types';

/** The `outbound` block of `AppConfig`, as the boot hands it over. */
export interface OutboundProxyConfig {
  readonly proxy?: string | undefined;
  readonly direct?: readonly string[] | undefined;
}

/** The installed resolver, or `undefined`: no ambient proxy, every call dials as it says. */
let ambient: ((target: URL) => string | undefined) | undefined;

/**
 * `true` for a host that is never sent through the ambient proxy: `localhost`, `*.localhost`, a
 * loopback literal, and each `direct` entry with every name under it (`cluster.local` covers
 * `a.svc.cluster.local`, never `notcluster.local`) — the NO_PROXY reading, per label.
 */
export function isDirectHost(hostname: string, direct: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (classifyAddress(host) === 'loopback') return true;
  return direct.some((entry) => {
    const name = entry.toLowerCase();
    return host === name || host.endsWith(`.${name}`);
  });
}

/**
 * The proxy URL as a log line or a report may show it: the userinfo replaced, never printed. Not a
 * URL at all is said as such — the raw text could be a credential with a typo in it.
 */
export function redactedProxyUrl(proxy: string): string {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return '(not a URL)';
  }
  const userinfo = url.username !== '' || url.password !== '' ? '***@' : '';
  return `${url.protocol}//${userinfo}${url.host}`;
}

/**
 * Installs the ambient proxy and answers its release, which restores what was there. The boot's
 * call alone (`serve-boot.ts`): an app declares `outbound` in `app.config.ts` and never calls this.
 * The URL is checked per hop by `proxyFor`, so a `socks5:` here is still `X_OUTBOUND_PROXY_INVALID`.
 */
export function configureOutboundProxy(config: OutboundProxyConfig | undefined): () => void {
  const before = ambient;
  const proxy = config?.proxy;
  const direct = [...(config?.direct ?? [])];
  ambient =
    proxy === undefined || proxy === ''
      ? undefined
      : (target: URL) => (isDirectHost(target.hostname, direct) ? undefined : proxy);
  if (ambient !== undefined && proxy !== undefined) {
    logger.info('ultimate outbound proxy', { proxy: redactedProxyUrl(proxy), direct });
  }
  return () => {
    ambient = before;
  };
}

/** What a call that names no proxy of its own goes through: `outbound.ts`'s `prepare()`. */
export function ambientOutboundProxy(): OutboundProxy | undefined {
  return ambient;
}

/**
 * The same answer for a transport that cannot be `outbound()` — the AI providers' streams,
 * storage's signed S3 calls — handed to Bun's `fetch` as `init.proxy`. `undefined`: no proxy
 * installed, loopback, a `direct` host, or not a URL (that call's own error, not this reader's).
 */
export function ambientProxyFor(target: string | URL): string | undefined {
  if (ambient === undefined) return undefined;
  if (target instanceof URL) return ambient(target);
  return URL.canParse(target) ? ambient(new URL(target)) : undefined;
}
