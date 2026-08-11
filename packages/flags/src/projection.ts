// Single responsibility: the declared flags as data — one JSON-safe shape for `x flags --json`,
// the MCP tool and the manifest, so all three answer "what is expired?" identically instead of
// each computing it. Same rule as `listErrorCodes()`: the projection lives with the registry.

import type { FlagKind } from './flag';
import { allFlags } from './registry';
import { flagsClock } from './runtime';
import type { FlagTargeting } from './targeting';

export interface FlagFacts {
  readonly key: string;
  readonly kind: FlagKind;
  readonly description: string;
  readonly targeting: FlagTargeting;
  /** ISO-8601, `null` for a permanent flag. */
  readonly expiresAt: string | null;
  readonly owner: string | null;
  /** Past its expiry as of this call. Always `false` for a permanent flag — it has no expiry. */
  readonly expired: boolean;
}

export interface FlagsReport {
  readonly flags: readonly FlagFacts[];
  /** The expired keys, lifted out: the one number a gate or a dashboard wants is this length. */
  readonly expired: readonly string[];
}

/** Sorted by key, so a diff of two reports is a diff of what changed. */
export function flagsReport(): FlagsReport {
  const nowMs = flagsClock().now().getTime();
  const flags = allFlags().map(
    (flag): FlagFacts => ({
      key: flag.key,
      kind: flag.kind,
      description: flag.description,
      targeting: flag.targeting,
      expiresAt: flag.expiresAt,
      owner: flag.owner,
      expired: flag.expiresAtMs !== null && nowMs >= flag.expiresAtMs,
    }),
  );
  return { flags, expired: flags.filter((flag) => flag.expired).map((flag) => flag.key) };
}
