// THE single invalidation entry point. `action.cache.invalidates`, `x cache bust`, the MCP
// tool and the admin panel all call this one function — nothing else may talk to a tier's
// `invalidateTags` directly. One hop reaches memo, LRU, Redis, ISR routes and the CDN, and
// the returned report is what the `/_x` cache panel renders, so "did it actually clear?" is
// answerable without a log dive.

import { currentSpan, logger, systemClock, withSpan } from '@ultimat3/core';
import { dependentsOfKind } from './graph';
import type { CacheTag } from './tags';
import { assertKnownTags, parseTag, serializeTags } from './tags';
import { isolateTierFailures, resetTierFailures } from './tier-failures';
import type { CacheTier, TierInvalidation } from './tiers';
import { sortTiers } from './tiers';

/** Revalidates one ISR route path. Provided by `@ultimat3/render`; absent on a worker. */
export type Revalidator = (path: string) => Promise<void> | void;

export interface InvalidationReport {
  readonly tags: readonly string[];
  readonly tiers: readonly TierInvalidation[];
  /** ISR route paths queued for regeneration. */
  readonly isr: readonly string[];
  /**
   * CDN paths the graph hangs off these tags — what *depends* on them, not what cleared. The
   * `cdn` tier is what purges them (as surrogate keys, with the tags), so what actually cleared
   * is that tier's row in `tiers`. With no `cdn` tier registered this list purges nowhere.
   */
  readonly cdn: readonly string[];
  readonly liveQueries: readonly string[];
  readonly durationMs: number;
  readonly errors: readonly { tier: string; message: string }[];
}

/** One completed `invalidateTags` call, kept for the `/_x` cache panel. */
export interface InvalidationEvent {
  /** ISO-8601, from core's `systemClock` — never `new Date()`. */
  readonly at: string;
  /** Wire-form tags, exactly `report.tags`. */
  readonly tags: readonly string[];
  /**
   * Everything the fan-out actually cleared: every tier key — the `cdn` tier's accepted purge
   * keys included — plus the ISR paths and the live queries.
   *
   * Deliberately NOT `report.cdn`: that is the dependency graph's answer to "what depends on
   * these tags", and folding it in here reported a path as busted when no `cdn` tier was
   * registered to purge it. A partial bust that reads as a clean one is the failure this log
   * exists to catch.
   */
  readonly busted: readonly string[];
  /**
   * What triggered it: the name of the span active when `invalidateTags` was called, or
   * `'invalidateTags'`.
   */
  readonly source: string;
  readonly durationMs: number;
  /** Tier failures, verbatim from the report — a partial bust must not read as a clean one. */
  readonly errors: readonly { readonly tier: string; readonly message: string }[];
}

// A dev log, not an audit trail — capped so a long-lived `x dev` process cannot grow it forever.
const MAX_INVALIDATION_LOG = 100;

/** Newest first. Module-private; read it through `recentInvalidations()`. */
const invalidationLog: InvalidationEvent[] = [];

function recordInvalidation(event: InvalidationEvent): void {
  invalidationLog.unshift(event);
  invalidationLog.length = Math.min(invalidationLog.length, MAX_INVALIDATION_LOG);
}

/** What the `/_x` cache panel renders: newest first, capped, a copy of the live log. */
export function recentInvalidations(): readonly InvalidationEvent[] {
  return [...invalidationLog];
}

const registry: CacheTier[] = [];
let revalidator: Revalidator | undefined;

/** Tiers register at boot from `app.config.ts`; order is normalised, not trusted. */
export function registerTier(tier: CacheTier): void {
  const existing = registry.findIndex((known) => known.name === tier.name);
  if (existing === -1) registry.push(tier);
  else registry[existing] = tier;
}

export function registeredTiers(): readonly CacheTier[] {
  return sortTiers(registry);
}

/**
 * Test seam: drops every registered tier, the revalidator, the invalidation log and the
 * swallowed-failure log. One reset, so a suite cannot clear half the recorded state.
 */
export function resetTiers(): void {
  registry.length = 0;
  revalidator = undefined;
  invalidationLog.length = 0;
  resetTierFailures();
}

/**
 * `isolateDeclaredTags()`'s contract over everything `resetTiers()` drops — `tags.ts` carries the
 * why. It must live here because three of the four pieces are unreachable from a test file: the
 * revalidator has no reader, and neither log has a writer, so a suite that reset them could put
 * back only the tier registry:
 *
 *   const restoreTiers = isolateTiers();
 *   afterAll(restoreTiers);
 *
 * Registration order is kept, not `sortTiers()`'s: `registeredTiers()` normalises on read, so
 * restoring the sorted list would hand the process back a registry it never had.
 */
export function isolateTiers(): () => void {
  const capturedTiers = [...registry];
  const capturedRevalidator = revalidator;
  const capturedLog = [...invalidationLog];
  const restoreFailures = isolateTierFailures();

  return () => {
    resetTiers();
    registry.push(...capturedTiers);
    revalidator = capturedRevalidator;
    invalidationLog.push(...capturedLog);
    restoreFailures();
  };
}

export function registerRevalidator(next: Revalidator): void {
  revalidator = next;
}

/**
 * Fan out `tags` across every registered tier plus the dependency graph. Never throws for a
 * tier failure: a dead Redis must not fail the write that triggered the bust — the failure
 * lands in `report.errors` and the entry expires by TTL.
 */
export function invalidateTags(tags: readonly CacheTag[]): Promise<InvalidationReport> {
  // Captured before `withSpan` opens `cache.invalidate` below: inside that callback the active
  // span is already this call's own, which would make every event's source the same string.
  const source = currentSpan()?.name ?? 'invalidateTags';

  return withSpan('cache.invalidate', async (): Promise<InvalidationReport> => {
    const startedAt = performance.now();
    assertKnownTags(tags);

    const tiers: TierInvalidation[] = [];
    const errors: { tier: string; message: string }[] = [];

    for (const tier of sortTiers(registry)) {
      try {
        tiers.push(await tier.invalidateTags(tags));
      } catch (error) {
        errors.push({
          tier: tier.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const isr = dependentsOfKind(tags, 'isr-route');
    const cdn = dependentsOfKind(tags, 'cdn-path');
    const liveQueries = dependentsOfKind(tags, 'live-query');

    for (const path of isr) {
      try {
        await revalidator?.(path);
      } catch (error) {
        errors.push({
          tier: 'isr',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const report: InvalidationReport = {
      tags: serializeTags(tags),
      tiers,
      isr,
      cdn,
      liveQueries,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      errors,
    };

    recordInvalidation({
      at: systemClock.now().toISOString(),
      tags: report.tags,
      busted: dedupe([
        ...report.tiers.flatMap((entry) => entry.keys),
        ...report.isr,
        ...report.liveQueries,
      ]),
      source,
      durationMs: report.durationMs,
      errors: report.errors,
    });

    if (errors.length > 0) logger.warn('cache.invalidate.partial', { ...report });
    return report;
  });
}

/** First-seen order kept — a union of what actually changed, not a sorted report. */
function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Convenience for `x cache bust post:1` — accepts the wire form agents see in reports. */
export function invalidateWireTags(wire: readonly string[]): Promise<InvalidationReport> {
  return invalidateTags(wire.map(parseTag));
}
