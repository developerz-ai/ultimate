// Single responsibility: where a webhook delivery is allowed to connect, decided BEFORE the first
// byte leaves. A tenant-supplied URL was opened as-is: loopback, RFC 1918, link-local — the cloud
// metadata service at 169.254.169.254 — so anyone who could register an endpoint could make the
// worker POST into the cluster. The host is resolved, every address it answers is classified by
// core's one classifier, and the connection is PINNED to the address that was approved.

import type { AddressClass } from '@ultimat3/core';
import { classifyAddress, isLocal, renderThrowable } from '@ultimat3/core';
import { WebhookEndpointInvalidError } from './webhook-errors';

/** Every address a hostname answers. Injected in tests: the network is sealed in this repo. */
export type WebhookResolve = (hostname: string) => Promise<readonly string[]>;

/** `Bun.dns.lookup` — the runtime's own resolver, every family, every address. */
export const resolveWebhookHost: WebhookResolve = async (hostname) =>
  (await Bun.dns.lookup(hostname)).map((entry) => entry.address);

/** The connection a delivery makes: an address the screen approved, and the name it proves. */
export interface WebhookTarget {
  /** The endpoint url with its host replaced by the approved address. */
  readonly url: string;
  /** The original `host[:port]`, sent as the `Host` header. */
  readonly host: string;
  /** For `https:` — the certificate is verified against the NAME, not the address. */
  readonly serverName?: string;
}

export interface WebhookTargetInput {
  readonly webhook: string;
  readonly endpointId: string;
  readonly url: URL;
  readonly allowPrivate: boolean;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  readonly resolve: WebhookResolve;
}

const refuse = (input: WebhookTargetInput, reason: string, fix: string): never => {
  throw new WebhookEndpointInvalidError({
    webhook: input.webhook,
    endpointId: input.endpointId,
    reason,
    fix,
  });
};

/**
 * The approved target, or `{ unresolved }` when the name did not resolve — a TRANSIENT failure
 * the queue retries, never a refusal. A refusal throws `X_WEBHOOK_ENDPOINT_INVALID`, and its
 * reason names the address CLASS, never the address: it reaches a durable dead-letter row.
 */
export async function webhookTarget(
  input: WebhookTargetInput,
): Promise<WebhookTarget | { readonly unresolved: string }> {
  // `http:` only where a dev receiver lives. A process that names no environment is production —
  // `fallback: 'production'`, the reading every dev-secret guard in the framework takes.
  if (input.url.protocol === 'http:' && !isLocal({ env: input.env, fallback: 'production' })) {
    refuse(
      input,
      'has an http: url outside a local environment, so the signed body would cross the network in clear',
      `give the endpoint an https:// url before webhook("${input.webhook}").endpoint returns it`,
    );
  }
  const hostname = input.url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  if (classifyAddress(hostname) !== undefined) {
    addresses = [hostname];
  } else {
    try {
      addresses = await input.resolve(hostname);
    } catch (error) {
      return { unresolved: `could not resolve the host: ${renderThrowable(error)}` };
    }
    if (addresses.length === 0) return { unresolved: 'the host resolved to no address' };
  }
  if (!input.allowPrivate) {
    const classes = addresses.map((address): AddressClass | 'unclassifiable' => {
      return classifyAddress(address) ?? 'unclassifiable';
    });
    const inside = classes.find((kind) => kind !== 'public');
    if (inside !== undefined) {
      refuse(
        input,
        `resolves to a ${inside} address, and a delivery only opens a public one`,
        `point the endpoint at a public https:// receiver — or, for a receiver inside your own network, pass allowPrivate: true to webhook("${input.webhook}")`,
      );
    }
  }
  // Pinned: the screen approved THESE addresses, and connecting by name would resolve again — a
  // name that answered public to the screen and private to the socket (DNS rebinding) walks past.
  const pinned = addresses[0] ?? hostname;
  const target = new URL(input.url.href);
  target.hostname = pinned.includes(':') ? `[${pinned}]` : pinned;
  return {
    url: target.href,
    host: input.url.host,
    ...(input.url.protocol === 'https:' ? { serverName: hostname } : {}),
  };
}
