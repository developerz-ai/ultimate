// What `/healthz` and `/readyz` say, and to whom — ONE rule for every role's listener. Both answer
// outside every pipeline, so the body is a stranger's to read: everyone gets the verdict, and the
// build id, the in-flight count and the readiness check names go only to a listed peer.

import { classifyAddress } from './address-class';
import type { HealthReport } from './lifecycle';
import type { Role } from './roles';

/** The box itself: `kubectl exec`, a port-forward, a compose healthcheck, a sidecar scraper. */
export const DEFAULT_HEALTH_DETAIL_PEERS: readonly string[] = ['loopback'];

/** The verdict a stranger gets. An allow-list, so a field `HealthReport` gains is withheld by default. */
export interface PublicHealthBody {
  readonly state: HealthReport['state'];
  readonly ready: boolean;
  readonly role: Role;
}

/** The body for one caller: the whole report for a listed peer, the verdict for anyone else. */
export function healthBody(
  report: HealthReport,
  role: Role,
  detailed: boolean,
): PublicHealthBody | (HealthReport & { readonly role: Role }) {
  return detailed ? { ...report, role } : { state: report.state, ready: report.ready, role };
}

/**
 * Whether `address` is one the list names: an entry is an address CLASS (`loopback`, `private`, …)
 * or one exact IP literal. Pure, and total — it runs on an unauthenticated probe path, so a list
 * that is not a list, an entry that is not a string and an address that is not a literal all
 * answer `false` rather than throw: nothing can vouch for them, whatever the list says.
 */
export function healthPeerListed(peers: readonly string[], address: string | null): boolean {
  if (address === null || !Array.isArray(peers)) return false;
  const kind = classifyAddress(address);
  if (kind === undefined) return false;
  const literal = address.trim().toLowerCase();
  return peers.some(
    (entry: unknown) =>
      typeof entry === 'string' && (entry === kind || entry.trim().toLowerCase() === literal),
  );
}
