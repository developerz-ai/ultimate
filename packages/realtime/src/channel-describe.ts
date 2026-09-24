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
  /**
   * The policy's display label. Never absent since 22.0.0 — `channel()` requires a policy, and a
   * channel any socket may join reads `allow('public')`'s label, said out loud.
   */
  readonly policy: string;
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
    policy: policyCapability(declared.policy),
    permissions: [...policyPermissions(declared.policy)].sort(),
  }));
}
