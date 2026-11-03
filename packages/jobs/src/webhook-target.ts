// Single responsibility: where a webhook delivery is allowed to connect, decided BEFORE the first
// byte leaves. A tenant-supplied URL was opened as-is: loopback, RFC 1918, link-local — the cloud
// metadata service at 169.254.169.254 — so anyone who could register an endpoint could make the
// worker POST into the cluster. The screen is core's `screenDial` — resolve, classify every address,
// pin — and this file keeps only what is a webhook's: the `http:` rule and its own refusal code.

import { isLocal } from '@ultimat3/core';
import type { DialResolve } from '@ultimat3/core/outbound';
import { screenDial } from '@ultimat3/core/outbound';
import { WebhookEndpointInvalidError } from './webhook-errors';

/** Every address a hostname answers. Injected in tests: the network is sealed in this repo. */
export type WebhookResolve = DialResolve;

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
  const verdict = await screenDial(input.url, {
    resolve: input.resolve,
    allowPrivate: input.allowPrivate,
  });
  if ('unresolved' in verdict) return { unresolved: verdict.unresolved };
  if ('refused' in verdict) {
    return refuse(
      input,
      `resolves to a ${verdict.refused} address, and a delivery only opens a public one`,
      `point the endpoint at a public https:// receiver — or, for a receiver inside your own network, pass allowPrivate: true to webhook("${input.webhook}")`,
    );
  }
  // Pinned by the screen: connecting by name would resolve again, and a name that answered public
  // to the screen and private to the socket (DNS rebinding) would walk past.
  return verdict.pin;
}
