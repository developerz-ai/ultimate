// The channel registry as the manifest reads it: one plain fact per declared channel, the policy
// flattened the way a query's is. Server-side on purpose — the policy flattening is
// `@ultimat3/query`'s, and a browser island declaring a channel must not bundle it.

import { policyCapability, policyPermissions } from '@ultimat3/query';
import { registeredChannels } from './channel-registry';

export interface ChannelDescription {
  readonly name: string;
  readonly params: readonly string[];
  /** The catch-up query's name, as `registerQueries` stamped it. */
  readonly catchUp: string;
  /** Record types (entity names) the channel carries, sorted. */
  readonly records: readonly string[];
  readonly events: boolean;
  /** The policy's display label, `null` for a channel any socket may join. */
  readonly policy: string | null;
  /** Every permission the policy asserts, flattened — what a report matches a grant against. */
  readonly permissions: readonly string[];
}

export function describeChannels(): readonly ChannelDescription[] {
  return registeredChannels().map((declared) => ({
    name: declared.name,
    params: [...declared.params],
    catchUp: declared.catchUp,
    records: declared.records.map((projection) => projection.type).sort(),
    events: declared.events,
    policy: declared.policy === undefined ? null : policyCapability(declared.policy),
    permissions:
      declared.policy === undefined ? [] : [...policyPermissions(declared.policy)].sort(),
  }));
}
