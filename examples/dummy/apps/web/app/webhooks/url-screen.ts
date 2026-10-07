/**
 * Which receiver URLs Postly registers: the ones the delivery mechanism would ever open. Screened
 * at REGISTRATION by the same two rules `@ultimat3/jobs`' address screen applies per attempt —
 * `http:` only in a local environment, and never an address inside a network — through core's own
 * `isLocal` and `classifyAddress`, so the two answers cannot drift. A NAME is screened again at
 * every delivery, where it is resolved and pinned; here only what needs no network is decided.
 */

import { classifyAddress, isLocal } from '@ultimat3/core';
import { EndpointUrlRefused } from './errors';

/** Refuses with `X_ORG_ENDPOINT_URL_REFUSED`, naming the rule and never the URL. */
export function screenEndpointUrl(
  raw: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): void {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLocal({ env, fallback: 'production' }))
  ) {
    throw new EndpointUrlRefused(
      `is ${url.protocol} — a signed delivery is sent over https: (http: only in a local environment)`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new EndpointUrlRefused('names this machine, and a delivery only opens a public address');
  }
  const kind = classifyAddress(host);
  if (kind !== undefined && kind !== 'public') {
    throw new EndpointUrlRefused(
      `is a ${kind} address, and a delivery only opens a public one — the metadata service and the cluster are not receivers`,
    );
  }
}
