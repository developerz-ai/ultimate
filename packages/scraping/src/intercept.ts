// One decision, asked by every driver before a request leaves: allow it, refuse it because
// `allowHosts` does not list the host, or refuse it because `block` names the resource type.
//
// It lives in its own file so the fake, the fixture and the real browser cannot answer it
// differently — `driver-parity.test.ts` asserts the same refusal on all three, and a rule
// re-implemented per driver is a rule that holds only on the driver nobody ships.

import type { HostRule } from './hosts';
import { hostDecision } from './hosts';
import type { NetworkEntry, ResourceType } from './rings';

export interface InterceptRules {
  readonly allowHosts: readonly HostRule[];
  /** Resource types never fetched. `['image', 'media', 'font']` is most scrapes' whole config. */
  readonly block?: readonly ResourceType[] | undefined;
}

export type InterceptVerdict = 'allow' | 'host' | 'blocked';

export function interceptVerdict(
  url: string,
  resourceType: ResourceType,
  rules: InterceptRules,
): InterceptVerdict {
  // Type first: a blocked image on an allowed host and a blocked image on a foreign host are both
  // "never fetched", and reporting the cheaper reason keeps `allowHosts` findings meaningful.
  if (rules.block?.includes(resourceType) === true) return 'blocked';
  return hostDecision(url, rules.allowHosts).allowed ? 'allow' : 'host';
}

/** The ring entry a refusal earns. Refusals are RECORDED, never silent — a scrape that came back
 * empty is diagnosed from this list. */
export const refusalEntry = (
  url: string,
  resourceType: ResourceType,
  verdict: Exclude<InterceptVerdict, 'allow'>,
  at: number,
): NetworkEntry => ({ method: 'GET', url, resourceType, at, refused: verdict });
