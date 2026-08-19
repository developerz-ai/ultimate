// THE single invalidation entry point. `action.cache.invalidates`, `x cache bust`, the MCP
// tool and the admin panel all call this one function — nothing else may talk to a tier's
// `invalidateTags` directly. One hop reaches memo, LRU, Redis, ISR routes and the CDN, and
// the returned report is what the `/_x` cache panel renders, so "did it actually clear?" is
// answerable without a log dive.

import { currentSpan, logger, renderThrowable, systemClock, withSpan } from '@ultimat3/core';
import { markInvalidated } from './fence';
import { dependentsOfKind } from './graph';
import type { CacheTag } from './tags';
import { assertKnownTags, knownTags, parseTag, serializeTags } from './tags';
import { isolateTierFailures, resetTierFailures } from './tier-failures';
import type { CacheTier, TierInvalidation } from './tiers';
import { sortTiers, TIER_ORDER } from './tiers';

/** Revalidates one ISR route path. Provided by `@ultimat3/render`; absent on a worker. */
export type Revalidator = (path: string) => Promise<void> | void;

/**
 * Carries wire tags to every OTHER process. The seam, never the transport: `cache` is tier 1 and
 * may not reach `realtime` (tier 3) or NATS, so `@ultimat3/cli` registers the sender at boot the
 * same way `@ultimat3/render` registers the `Revalidator`.
 *
 * Without one, `invalidateTags` clears the LRU of exactly one process: a user edits their profile
 * on pod 3, their next request lands on pod 7, and pod 7's in-process copy serves the pre-edit
 * value for up to `defaultTtlMs`. The user watches their edit vanish and re-submits.
 */
export type InvalidationBroadcast = (wireTags: readonly string[]) => Promise<void> | void;

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
let broadcast: InvalidationBroadcast | undefined;

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
  broadcast = undefined;
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
  const capturedBroadcast = broadcast;
  const capturedLog = [...invalidationLog];
  const restoreFailures = isolateTierFailures();

  return () => {
    resetTiers();
    registry.push(...capturedTiers);
    revalidator = capturedRevalidator;
    broadcast = capturedBroadcast;
    invalidationLog.push(...capturedLog);
    restoreFailures();
  };
}

export function registerRevalidator(next: Revalidator): void {
  revalidator = next;
}

/**
 * Registers the outbound half of cross-instance invalidation. Called once at boot by whatever
 * owns the transport — `@ultimat3/cli`, not this package.
 */
export function registerInvalidationBroadcast(next: InvalidationBroadcast): void {
  broadcast = next;
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
  return fanOut(tags, { source, emit: true, validate: true, errors: [] });
}

/**
 * The inbound half: another instance's fan-out, applied here.
 *
 * It cannot re-emit, and that is structural rather than a flag a caller could set wrong — `emit`
 * lives on `fanOut`'s private options and this is the only entry point that passes `false`. A
 * broadcast that re-broadcast would be a storm bounded by nothing.
 *
 * A tag this process has not declared is DROPPED and reported, never thrown: mid-deploy the new
 * pods know an entity the old ones do not, and a throw here kills the subscriber loop that
 * delivered it — which would silently end cross-instance invalidation for the whole process.
 */
export function receiveInvalidationBroadcast(wire: readonly string[]): Promise<InvalidationReport> {
  const declared = new Set(knownTags());
  const errors: { tier: string; message: string }[] = [];
  const accepted: CacheTag[] = [];
  for (const value of wire) {
    const parsed = parseTag(value);
    // An empty registry is `assertKnownTags`'s "validation is off" state; honour the same rule.
    if (declared.size === 0 || declared.has(parsed.entity)) accepted.push(parsed);
    else errors.push({ tier: 'broadcast', message: `ignored undeclared tag "${value}"` });
  }
  return fanOut(accepted, { source: 'cache.broadcast', emit: false, validate: false, errors });
}

interface FanOutOptions {
  readonly source: string;
  /** Never widened to a public parameter: see `receiveInvalidationBroadcast`. */
  readonly emit: boolean;
  /** The local path throws on a typo; the inbound one has already filtered instead. */
  readonly validate: boolean;
  readonly errors: { tier: string; message: string }[];
}

function fanOut(tags: readonly CacheTag[], options: FanOutOptions): Promise<InvalidationReport> {
  const { source, emit } = options;

  return withSpan('cache.invalidate', async (): Promise<InvalidationReport> => {
    const startedAt = performance.now();
    // Inside the span, so a typo is a REJECTED promise and not a synchronous throw past every
    // caller that only ever awaited this function.
    if (options.validate) assertKnownTags(tags);

    // Before the first tier is touched, so a read-through fill whose `load()` started earlier
    // cannot republish what this call is about to clear — the bust would otherwise land on a key
    // that is not there yet, report `errors: []`, and be overwritten milliseconds later.
    markInvalidated({ tags });

    const tiers: TierInvalidation[] = [];
    const errors = options.errors;

    // FARTHEST tier first. Near-to-far leaves the far tier holding the old value after the near
    // ones are clear, and a read racing the bust promotes it straight back up into them — the
    // report says every tier cleared, and the LRU is stale again before the call returns.
    for (const tier of [...sortTiers(registry)].reverse()) {
      try {
        tiers.push(await tier.invalidateTags(tags));
      } catch (error) {
        // `renderThrowable`, never `error.message`: a tier is app-supplied, so the value it
        // rejects with is too, and both `instanceof` and `String()` RUN app code on it. A render
        // that throws here rejects the whole fan-out — the failure the line above promises not to
        // let reach the write that triggered the bust.
        errors.push({ tier: tier.name, message: renderThrowable(error) });
      }
    }
    // The report is read order, not clear order: it is what the `/_x` panel renders, and a ladder
    // printed upside down is a second thing for a reader to learn.
    tiers.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

    const isr = dependentsOfKind(tags, 'isr-route');
    const cdn = dependentsOfKind(tags, 'cdn-path');
    const liveQueries = dependentsOfKind(tags, 'live-query');

    for (const path of isr) {
      try {
        await revalidator?.(path);
      } catch (error) {
        errors.push({ tier: 'isr', message: renderThrowable(error) });
      }
    }

    const wire = serializeTags(tags);

    // Last, and best-effort: every LOCAL tier has already cleared, so a dead transport degrades
    // to "the other pods clear on TTL" rather than failing the write that triggered the bust.
    if (emit && wire.length > 0 && broadcast !== undefined) {
      try {
        await broadcast(wire);
      } catch (error) {
        errors.push({ tier: 'broadcast', message: renderThrowable(error) });
      }
    }

    const report: InvalidationReport = {
      tags: wire,
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
