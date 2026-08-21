// Token and cost budgets, per request / per actor / per org.
//
// A budget REFUSES; it never truncates. A silently shortened prompt produces a confidently
// wrong answer that looks like a real one, and the caller has no signal anything happened.
// A thrown X_AI_BUDGET_EXCEEDED with the remaining count is strictly more useful.
//
// The carrier is an async context so nested calls (a RAG retrieval, a tool call that generates,
// an eval judge) all debit the same ledger without threading it through every signature. It opens
// through `@ultimat3/core`'s one lazy seam rather than constructing an `AsyncLocalStorage` here: a
// module-scope `new` threw at EVALUATION in a browser bundle, where the bundler stubs
// `node:async_hooks` to `{}`, and took every importer of `@ultimat3/ai` with it.

import { asyncContext } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { assertSameCurrency } from '@ultimat3/money';
import { AiBudgetExceededError } from './errors';
import type { GenerateRequest, TokenUsage } from './provider';
import { estimateCost, estimateInputTokens, estimateTokens, totalTokens } from './provider';

/** Ceilings. An omitted scope is unlimited — declare the ones that matter. */
export interface BudgetLimits {
  /** Token ceiling for one `generate`/`stream` call, including its pre-flight estimate. */
  readonly request?: number;
  /**
   * Prompt-token ceiling for ONE call. Distinct from `request`, which counts the completion
   * too: a prompt is what the caller assembles and can shorten, a completion is not.
   */
  readonly tokensIn?: number;
  /** Token ceiling for the acting identity across its whole window. */
  readonly actor?: number;
  /** Token ceiling for the organisation across its whole window. */
  readonly org?: number;
  /**
   * Money ceiling for ONE call, checked against the worst-case estimate before the call.
   * Per call rather than accumulated, because that is the knob an app can reason about:
   * "no single answer may cost more than this". Integer minor units, never a float.
   */
  readonly costPerCall?: Money;
}

/**
 * What one call is about to cost, priced before it happens. One object rather than a growing
 * argument list, so a new scope is a new field here and never a new call site.
 */
export interface SpendEstimate {
  /** Prompt tokens — what `tokensIn` caps. */
  readonly inputTokens: number;
  /** Prompt plus worst-case completion — what the request/actor/org scopes count. */
  readonly tokens: number;
  /** Worst-case price, in integer minor units. */
  readonly cost: Money;
}

/** Price a request pre-flight. The pessimistic read on purpose — see `estimateCost`. */
export function estimateSpend(request: GenerateRequest): SpendEstimate {
  return {
    inputTokens: estimateInputTokens(request),
    tokens: estimateTokens(request),
    cost: estimateCost(request),
  };
}

/** Where cross-request counters live. Swap for Redis in a multi-process deployment. */
export interface BudgetStore {
  spent(key: string): Promise<number> | number;
  /** `tokens` may be NEGATIVE: releasing a reservation the call never spent is a credit. */
  add(key: string, tokens: number): Promise<void> | void;
  reset(key?: string): Promise<void> | void;
}

/**
 * What `reserve` debited, so `record` can reconcile it against the provider's real counts and
 * `release` can give it back. Held by the caller rather than the ledger because one ledger serves
 * every concurrent call in a request, and each one owns its own reservation.
 */
export interface BudgetReservation {
  readonly tokens: number;
}

export class MemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, number>();

  spent(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  add(key: string, tokens: number): void {
    this.counters.set(key, this.spent(key) + tokens);
  }

  reset(key?: string): void {
    if (key === undefined) this.counters.clear();
    else this.counters.delete(key);
  }
}

export interface BudgetLedgerInput {
  readonly limits: BudgetLimits;
  /** Stable identity keys. Omit a key to skip that scope even when a limit is set. */
  readonly actorKey?: string;
  readonly orgKey?: string;
  readonly store?: BudgetStore;
  readonly currency?: string;
}

export interface BudgetReport {
  readonly requestTokens: number;
  readonly cost: Money;
  readonly limits: BudgetLimits;
  readonly actorSpent: number;
  readonly orgSpent: number;
}

export class BudgetLedger {
  private readonly limits: BudgetLimits;
  private readonly actorKey: string | undefined;
  private readonly orgKey: string | undefined;
  private readonly store: BudgetStore;
  private requestTokens = 0;
  private costMinor = 0;
  private readonly currency: string;
  /**
   * The ledger this one was `derive`d from, or `undefined` for a scope's root. Set by `derive`
   * rather than taken through `BudgetLedgerInput`, so the chain is always the derivation and a
   * caller cannot build a cycle out of it.
   *
   * Without it a derived ledger reported to nobody: `llm()` derives one per call, so the ambient
   * ledger `gateway.scope()` installed counted zero tokens and zero cost however many calls ran
   * inside it, and its `request` ceiling was re-granted in full to every one of them.
   */
  private parent: BudgetLedger | undefined;
  /**
   * Reservations take turns. Check-then-debit spans an `await store.spent()`, and three callers
   * interleaving inside it is the bypass this ledger exists to close — one event loop, so a
   * promise chain IS the lock. A store shared across PROCESSES needs an atomic increment of its
   * own; this closes the parallelism inside one.
   */
  private turnstile: Promise<unknown> = Promise.resolve();

  constructor(input: BudgetLedgerInput) {
    this.limits = input.limits;
    this.actorKey = input.actorKey;
    this.orgKey = input.orgKey;
    this.store = input.store ?? new MemoryBudgetStore();
    this.currency = input.currency ?? 'USD';
  }

  /**
   * Check an estimate against every applicable scope BEFORE the call, then DEBIT it. Throws on
   * the first scope that cannot cover it, naming that scope, so the fix line points at one knob
   * rather than four.
   *
   * The debit is what makes the ceiling hold under parallelism. Checking without debiting meant
   * three concurrent calls under one ledger all read `spent() === 0`, all passed, and all three
   * recorded against a ceiling only one of them fitted — an "un-bypassable" org budget bypassed
   * by `Promise.all`. `record` replaces the estimate with the real counts; `release` gives it
   * back when the call never happened.
   */
  async reserve(estimate: SpendEstimate): Promise<BudgetReservation> {
    // The ROOT's turnstile, not this ledger's: reservations under one scope take turns even when
    // each call derived its own ledger, which is every `llm()` call. A per-ledger queue serialised
    // nothing once `derive` existed — `Promise.all` of three derived ledgers all read the chain
    // before any of them debited it.
    const gate = this.rootLedger();
    const turn = gate.turnstile.then(() => this.reserveNow(estimate));
    // Chained on a settled shadow: one refusal must not reject every reservation queued behind it.
    gate.turnstile = turn.catch(() => undefined);
    return await turn;
  }

  private rootLedger(): BudgetLedger {
    let ledger: BudgetLedger = this;
    while (ledger.parent !== undefined) ledger = ledger.parent;
    return ledger;
  }

  private async reserveNow(estimate: SpendEstimate): Promise<BudgetReservation> {
    // Every ledger in the chain, because each keeps its own counter and the tightest limit is not
    // always the one with the most spent against it.
    for (let l: BudgetLedger | undefined = this; l !== undefined; l = l.parent) {
      l.assertScope('request', l.limits.request, l.requestTokens, estimate.tokens);
    }
    // Per call, so nothing is "already spent" against it.
    this.assertScope('tokensIn', this.limits.tokensIn, 0, estimate.inputTokens);
    if (this.limits.actor !== undefined && this.actorKey !== undefined) {
      const spent = await this.store.spent(this.actorKey);
      this.assertScope(`actor:${this.actorKey}`, this.limits.actor, spent, estimate.tokens);
    }
    if (this.limits.org !== undefined && this.orgKey !== undefined) {
      const spent = await this.store.spent(this.orgKey);
      this.assertScope(`org:${this.orgKey}`, this.limits.org, spent, estimate.tokens);
    }
    this.assertCost(estimate.cost);
    await this.debit(estimate.tokens);
    return { tokens: estimate.tokens };
  }

  /** Give a reservation back: a provider that threw, a stream abandoned before `done`. */
  async release(reservation: BudgetReservation | undefined): Promise<void> {
    if (reservation === undefined) return;
    await this.debit(-reservation.tokens);
  }

  /**
   * A nested ledger for one call: the TIGHTER of each limit, the same identity keys and the
   * same store. Tightening rather than replacing is the point — a per-call budget declared on
   * an `llm()` action must not be able to widen the actor or org ceiling it runs inside.
   */
  derive(limits: BudgetLimits): BudgetLedger {
    const child = new BudgetLedger({
      limits: {
        ...pick('request', tighterNumber(this.limits.request, limits.request)),
        ...pick('tokensIn', tighterNumber(this.limits.tokensIn, limits.tokensIn)),
        ...pick('actor', tighterNumber(this.limits.actor, limits.actor)),
        ...pick('org', tighterNumber(this.limits.org, limits.org)),
        ...pick('costPerCall', tighterMoney(this.limits.costPerCall, limits.costPerCall)),
      },
      ...(this.actorKey !== undefined ? { actorKey: this.actorKey } : {}),
      ...(this.orgKey !== undefined ? { orgKey: this.orgKey } : {}),
      store: this.store,
      currency: this.currency,
    });
    child.parent = this;
    return child;
  }

  /**
   * Debit ACTUAL usage after the call, replacing the estimate `reserve` worked from — so only
   * the DIFFERENCE lands here. Called without the reservation it behaves as it always did and
   * debits the full amount, which double-counts a reserved call: pass the handle `reserve`
   * returned.
   */
  async record(usage: TokenUsage, cost: Money, reservation?: BudgetReservation): Promise<void> {
    // Up the chain, because `derive` copies the currency: a scope's reported cost is its own
    // calls plus every call made under a ledger derived from it.
    for (let l: BudgetLedger | undefined = this; l !== undefined; l = l.parent) {
      l.costMinor += cost.minor;
    }
    await this.debit(totalTokens(usage) - (reservation?.tokens ?? 0));
  }

  /**
   * The one write path. Negative credits a release or an over-estimate back.
   *
   * The in-memory counters walk the chain; the STORE is written once, by the ledger the call was
   * made on. A child shares its parent's store and identity keys, so debiting through the parent
   * as well would bill the actor and the org twice for one call.
   */
  private async debit(tokens: number): Promise<void> {
    if (tokens === 0) return;
    for (let l: BudgetLedger | undefined = this; l !== undefined; l = l.parent) {
      l.requestTokens += tokens;
    }
    if (this.actorKey !== undefined) await this.store.add(this.actorKey, tokens);
    if (this.orgKey !== undefined) await this.store.add(this.orgKey, tokens);
  }

  async report(): Promise<BudgetReport> {
    return {
      requestTokens: this.requestTokens,
      cost: { minor: this.costMinor, currency: this.currency },
      limits: this.limits,
      actorSpent: this.actorKey === undefined ? 0 : await this.store.spent(this.actorKey),
      orgSpent: this.orgKey === undefined ? 0 : await this.store.spent(this.orgKey),
    };
  }

  private assertScope(scope: string, limit: number | undefined, spent: number, want: number): void {
    if (limit === undefined) return;
    const remaining = limit - spent;
    if (want > remaining) {
      throw new AiBudgetExceededError({ scope, requested: want, remaining, limit });
    }
  }

  /** Per-call, so `remaining` IS the limit. Currencies must match; a mismatch is a config bug. */
  private assertCost(cost: Money): void {
    const limit = this.limits.costPerCall;
    if (limit === undefined) return;
    assertSameCurrency(limit, cost);
    if (cost.minor > limit.minor) {
      throw new AiBudgetExceededError({
        scope: 'costPerCall',
        requested: cost.minor,
        remaining: limit.minor,
        limit: limit.minor,
        unit: `${limit.currency} minor units`,
      });
    }
  }
}

/** Spreadable single-key record, so an absent limit stays absent under exactOptionalPropertyTypes. */
function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function tighterNumber(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function tighterMoney(a: Money | undefined, b: Money | undefined): Money | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  assertSameCurrency(a, b);
  return a.minor <= b.minor ? a : b;
}

const storage = asyncContext<BudgetLedger>('an AI budget');

/** Run `fn` with `ledger` as the ambient budget for everything it awaits. */
export function withBudget<T>(ledger: BudgetLedger, fn: () => Promise<T>): Promise<T> {
  return storage.run(ledger, fn);
}

/** The ambient ledger, or `undefined` outside a budget scope (spend is then unmetered). */
export function currentBudget(): BudgetLedger | undefined {
  return storage.get();
}
