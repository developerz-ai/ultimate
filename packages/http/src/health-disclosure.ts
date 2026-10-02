// What `/healthz` and `/readyz` say, and to whom. Both answer outside the pipeline — no auth, no
// rate limit — so the body is a stranger's to read: everyone gets the verdict, and the build id,
// the in-flight count and the readiness check names go only to a peer `healthDetailPeers` lists.

import {
  type AddressClass,
  classifyAddress,
  type HealthReport,
  type Role,
  renderCauseValue,
} from '@ultimat3/core';
import type { HttpConfig } from './config';
import { HttpError } from './errors';
import { forwardedClientAddress } from './forwarded';

/** The box itself: `kubectl exec`, a port-forward, a compose healthcheck, a sidecar scraper. */
export const DEFAULT_HEALTH_DETAIL_PEERS: readonly string[] = ['loopback'];

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

const listed = (peers: readonly string[], address: string | null): boolean => {
  if (address === null) return false;
  const kind = classifyAddress(address);
  // Not an address literal: nothing can vouch for it, whatever the list says.
  if (kind === undefined) return false;
  const literal = address.trim().toLowerCase();
  return peers.some((entry) => entry === kind || entry.trim().toLowerCase() === literal);
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
  if (!listed(peers, input.socketAddress)) return false;
  const forwarded = forwardedClientAddress(input.headers, input.config);
  return forwarded === undefined || listed(peers, forwarded);
};

/** The verdict a stranger gets. An allow-list, so a field core adds later is withheld by default. */
export interface PublicHealthBody {
  readonly state: HealthReport['state'];
  readonly ready: boolean;
  readonly role: Role;
}

export const healthBody = (
  report: HealthReport,
  role: Role,
  detailed: boolean,
): PublicHealthBody | (HealthReport & { readonly role: Role }) =>
  detailed ? { ...report, role } : { state: report.state, ready: report.ready, role };
