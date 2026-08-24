// Single responsibility: the declared flags as data — one JSON-safe shape, so no surface has to
// compute "what is expired?" for itself. Same rule as `listErrorCodes()`: the projection lives
// with the registry.
//
// OFFERED, not published (`As of 2026-08-24`). This header used to state that `x flags --json`,
// an MCP tool and the manifest all read it. **None of the three exists**: there is no `x flags`
// command, `ARRAY_SECTIONS` in `@ultimat3/manifest` has no `flags` section, no MCP tool names one,
// and `flagsReport` has zero callers outside this package's own test. `packages/flags/CLAUDE.md`
// has always said so; only this file stated the plan as fact, which is the shape
// `@ultimat3/ai`'s `agent-facts.ts` names — the SHAPE a surface would publish, never a row any
// surface carries.
//
// And one of the three could never have been the consumer it named: a manifest is a build artefact
// derived from SOURCE, while `allFlags()` is process-global runtime state filled by the app's own
// imports — so in a CLI process that has not loaded the app this answers `{ flags: [], expired: []
// }`, which is `@ultimat3/http`'s deleted `appErrorStatus()` exactly. A CLI command is the reachable
// consumer, because `loadApp` imports the app's modules before the command runs.

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
