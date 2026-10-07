// Who `/healthz` and `/readyz` tell the detail to on the WEB role: the `healthDetailPeers` config
// key, its screen, and the trusted-proxy half. The body rule and the peer-list match are core's
// (`health-disclosure.ts` there), shared with the sync role's own listener — one rule, two callers.

import {
  type AddressClass,
  classifyAddress,
  healthPeerListed,
  renderCauseValue,
} from '@ultimat3/core';
import type { HttpConfig } from './config';
import { HttpError } from './errors';
import { forwardedClientAddress } from './forwarded';

/** Every class an entry may name. A `Record` so a class core adds is a build error here. */
const ADDRESS_CLASSES = Object.freeze<Record<AddressClass, true>>({
  loopback: true,
  private: true,
  'link-local': true,
  ula: true,
  cgnat: true,
  unspecified: true,
  reserved: true,
  public: true,
});

const isAddressClass = (entry: string): entry is AddressClass =>
  Object.hasOwn(ADDRESS_CLASSES, entry);

/** Beside its one caller: `errors.ts` is at the 500-line ceiling (`server.ts` does the same). */
const healthDetailPeersInvalid = (value: unknown): HttpError =>
  new HttpError({
    code: 'X_CONFIG_INVALID',
    cause: `http.healthDetailPeers holds ${renderCauseValue(value)}; it must be a list whose every entry is an address class (${Object.keys(ADDRESS_CLASSES).join(', ')}) or one IP address literal — a range, a hostname or a misspelt class would match nobody, and the health endpoints would silently withhold from the peer it was written for`,
    fix: "configureHttp({ healthDetailPeers: ['loopback', 'private'] })",
  });

/** The declared list, or the refusal naming the entry no address can ever match. */
export const assertHealthDetailPeers = (peers: readonly string[]): readonly string[] => {
  const declared: unknown = peers;
  if (!Array.isArray(declared)) throw healthDetailPeersInvalid(declared);
  for (const entry of declared as readonly unknown[]) {
    if (typeof entry !== 'string') throw healthDetailPeersInvalid(entry);
    if (!isAddressClass(entry) && classifyAddress(entry) === undefined) {
      throw healthDetailPeersInvalid(entry);
    }
  }
  return [...(declared as readonly string[])];
};

/**
 * Whether this caller is told the detail. The SOCKET must be listed — and, when a declared proxy
 * named a caller, that caller too: a proxy on this box makes every socket loopback, and a direct
 * caller forging `x-forwarded-for` still arrives on a socket nobody listed. Undeclared, the
 * header is not read at all.
 */
export const disclosesHealthDetail = (input: {
  readonly config: HttpConfig;
  readonly headers: Headers;
  readonly socketAddress: string | null;
}): boolean => {
  const peers = input.config.healthDetailPeers;
  if (!healthPeerListed(peers, input.socketAddress)) return false;
  const forwarded = forwardedClientAddress(input.headers, input.config);
  return forwarded === undefined || healthPeerListed(peers, forwarded);
};
