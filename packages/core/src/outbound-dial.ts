// Single responsibility: where a dial to a URL may land, decided BEFORE the first byte leaves —
// resolve the name, classify every address it answers by core's one classifier, and pin the
// connection to an approved address. `@ultimat3/jobs`' webhook target, `@ultimat3/scraping`'s
// wildcard leg and `outbound({ dial: 'public' })` each held a copy of this; now they call it.

import type { AddressClass } from './address-class';
import { classifyAddress } from './address-class';
import { renderThrowable } from './error-render';

/** Every address a hostname answers. Injected in tests: the network is sealed in this repo. */
export type DialResolve = (hostname: string) => Promise<readonly string[]>;

/** `Bun.dns.lookup` — the runtime's own resolver, every family, every address. The one call site. */
export const resolveDialHost: DialResolve = async (hostname) =>
  (await Bun.dns.lookup(hostname)).map((entry) => entry.address);

/** The connection a screened dial makes: an approved address, and the name it proves. */
export interface DialPin {
  /** The URL with its host replaced by the approved address. */
  readonly url: string;
  /** The original `host[:port]`, sent as the `Host` header. */
  readonly host: string;
  /** For `https:` — the certificate is verified against the NAME, not the address. */
  readonly serverName?: string;
}

/**
 * What the screen decided. `unresolved` is a name that did not resolve — a TRANSIENT fact the
 * caller decides about (a webhook retries it, a scrape refuses it), carrying the resolver's error
 * when there was one. `refused` names the address CLASS, never the address: a reason reaches a
 * durable dead-letter row.
 */
export type DialVerdict =
  | { readonly pin: DialPin }
  | { readonly refused: AddressClass | 'unclassifiable' }
  | { readonly unresolved: string; readonly error?: unknown };

export interface ScreenDialOptions {
  readonly resolve?: DialResolve | undefined;
  /** Skip the class check, still pin: a receiver the app declared to be inside its network. */
  readonly allowPrivate?: boolean | undefined;
}

/**
 * Why `url` may not be dialled as a public vendor, before any name is resolved, or `undefined`.
 * `http:` only where a dev receiver lives (`local`), and no credentials in the URL: they would ride
 * every hop and every log line. Asked of each redirect hop as well as the first URL.
 */
export function publicUrlRefusal(url: URL, local: boolean): string | undefined {
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return `${url.protocol} is not https:, the only scheme a public dial takes outside a local environment`;
  }
  if (url.username !== '' || url.password !== '') {
    return 'the URL carries credentials, which would ride every hop and every log line';
  }
  return undefined;
}

/** The refusal reason for a verdict that is not a pin, phrased by class, never by address. */
export function dialRefusalReason(verdict: DialVerdict): string | undefined {
  if ('refused' in verdict) return `the host resolves to a ${verdict.refused} address`;
  if ('unresolved' in verdict) return verdict.unresolved;
  return undefined;
}

/**
 * Screen and pin `url`. An address literal is classified as itself; a name is resolved and ONE
 * address that is not public refuses it, because the socket may pick any of them. Pinned: the
 * screen approved THESE addresses, and connecting by name would resolve again — a name answering
 * public here and private to the socket (DNS rebinding) would walk past.
 */
export async function screenDial(url: URL, options: ScreenDialOptions = {}): Promise<DialVerdict> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  if (classifyAddress(hostname) !== undefined) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (options.resolve ?? resolveDialHost)(hostname);
    } catch (error) {
      return { unresolved: `could not resolve the host: ${renderThrowable(error)}`, error };
    }
    if (addresses.length === 0) return { unresolved: 'the host resolved to no address' };
  }
  if (options.allowPrivate !== true) {
    const refused = addresses
      .map(
        (address): AddressClass | 'unclassifiable' => classifyAddress(address) ?? 'unclassifiable',
      )
      .find((kind) => kind !== 'public');
    if (refused !== undefined) return { refused };
  }
  const pinned = addresses[0] ?? hostname;
  const target = new URL(url.href);
  target.hostname = pinned.includes(':') ? `[${pinned}]` : pinned;
  return {
    pin: {
      url: target.href,
      host: url.host,
      ...(url.protocol === 'https:' ? { serverName: hostname } : {}),
    },
  };
}
