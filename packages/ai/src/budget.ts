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

import type { Actor } from '@ultimat3/core';
import { assert, asyncContext, finiteCount } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { assertSameCurrency } from '@ultimat3/money';
import { AiBudgetExceededError } from './errors';
import type { GenerateRequest, TokenUsage } from './provider';
import { estimateCost, estimateInputTokens, estimateTokens, totalTokens } from './provider';

/** Ceilings. An omitted scope is unlimited — declare the ones that matter. */
export interface BudgetLimits {
  /**
   * Token ceiling for one call CHAIN — every `generate`/`stream` sharing a ledger, pre-flight
   * estimates included. An `llm()` repair turn and an `agent()` turn each debit the same ledger,
   * so this is not "one provider call" once a scope is open.
   */
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

/**
 * What one `take` found. `spent` is the counter as the store read it, BEFORE this take — so a
 * refusal can say how much was left.
 */
export interface BudgetTake {
  readonly taken: boolean;
  readonly spent: number;
}

/** Where cross-request counters live. Swap for Redis in a multi-process deployment. */
export interface BudgetStore {
  spent(key: string): Promise<number> | number;
  /** `tokens` may be NEGATIVE: releasing a reservation the call never spent is a credit. */
  add(key: string, tokens: number): Promise<void> | void;
  /**
   * Add `tokens` to `key` only if the total stays at or under `limit`, in ONE atomic step — a
   * Redis `EVAL`, a SQL `update … set spent = spent + $2 where key = $1 and spent + $2 <= $3`.
   * Required, with no default built on `spent` + `add`: that pair is the read-then-write two
   * concurrent requests both pass, which is the overspend this member exists to close.
   */
  take(key: string, tokens: number, limit: number): Promise<BudgetTake> | BudgetTake;
  reset(key?: string): Promise<void> | void;
}

/**
 * The store keys a call's identity is counted under: the acting identity (kind and id — one window
 * per actor, whichever org it acts in) and its org, when it has one. Derived, never taken from a
 * declaration, so every `llm()`, `agent()` and `hive()` binds the gateway's `actor` / `org` ceilings
 * to whoever called it. An anonymous caller is one identity: every anonymous call shares its window.
 */
export interface BudgetKeys {
  readonly actorKey?: string;
  readonly orgKey?: string;
}

export function budgetKeysFor(actor: Actor): BudgetKeys {
  return {
    actorKey: `actor:${actor.kind}:${actor.id}`,
    ...(actor.orgId === undefined ? {} : { orgKey: `org:${actor.orgId}` }),
  };
}

/**
 * What `reserve` debited, so `record` can reconcile it against the provider's real counts and
 * `release` can give it back. Held by the caller rather than the ledger because one ledger serves
 * every concurrent call in a request, and each one owns its own reservation.
 */
export interface BudgetReservation {
  readonly tokens: number;
}

/**
 * The per-process default. There is NO window: a counter lives until `reset()` or a restart, so an
 * `actor` / `org` ceiling here is "per process lifetime". It holds one entry per caller that has
 * spent under a DECLARED ceiling (none at all without one), and deliberately no eviction: dropping
 * a counter hands that caller its whole ceiling back, which is the bypass the ceiling exists to
 * stop. A window — per day, per month — is a shared store whose keys expire.
 */
export class MemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, number>();

  spent(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /** A counter back at zero is deleted: absent and zero are the same answer, and an entry costs. */
  add(key: string, tokens: number): void {
    this.write(key, this.spent(key) + tokens);
  }

  /** Atomic because it is synchronous: nothing else runs between the read and the write. */
  take(key: string, tokens: number, limit: number): BudgetTake {
    const spent = this.spent(key);
    if (spent + tokens > limit) return { taken: false, spent };
    this.write(key, spent + tokens);
    return { taken: true, spent };
  }

  /** How many counters are held — one per caller that has spent under a declared ceiling. */
  size(): number {
    return this.counters.size;
  }

  private write(key: string, total: number): void {
    if (total === 0) this.counters.delete(key);
    else this.counters.set(key, total);
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

  constructor(input: BudgetLedgerInput) {
    // The ceilings are screened where they LAND, because `assertScope` compares with `>`: a `NaN`
    // limit makes `limit - spent` a `NaN`, `want > NaN` false, and the scope silently unlimited —
    // the ceiling does not become wrong, it stops existing. `llm()`, `agent()` and `hive()` screen
    // the same numbers first under the key names their declarations use (`tokensPerRun` is this
    // `request`), so this is the backstop for a `createGateway({ budget })` or a hand-built ledger,
    // where these ARE the names the caller wrote.
    this.limits = assertFiniteLimits(input.limits);
    this.actorKey = input.actorKey;
    this.orgKey = input.orgKey;
    this.store = input.store ?? new MemoryBudgetStore();
    this.currency = input.currency ?? 'USD';
  }

  /**
   * Check an estimate against every applicable scope BEFORE the call, and DEBIT it in the same
   * step. Throws on the first scope that cannot cover it, naming that scope, so the fix line points
   * at one knob rather than four.
   *
   * Debit-then-check, never check-then-debit: the in-memory scopes are checked and debited with no
   * `await` between (one event loop, so that IS atomic), and the store's scopes go through its
   * atomic `take`. Any read-then-write across an `await` lets concurrent calls — `Promise.all` of
   * derived ledgers, or one request per scope racing one org key — all read the same `spent`, all
   * pass, and all debit a ceiling only one fitted. A refusal at a later scope gives back what the
   * earlier ones took. `record` replaces the estimate with the real counts; `release` gives it back
   * when the call never happened.
   */
  async reserve(estimate: SpendEstimate): Promise<BudgetReservation> {
    // Every ledger in the chain, because each keeps its own counter and the tightest limit is not
    // always the one with the most spent against it.
    for (let l: BudgetLedger | undefined = this; l !== undefined; l = l.parent) {
      l.assertScope('request', l.limits.request, l.requestTokens, estimate.tokens);
    }
    // Per call, so nothing is "already spent" against it.
    this.assertScope('tokensIn', this.limits.tokensIn, 0, estimate.inputTokens);
    this.assertCost(estimate.cost);
    this.debitChain(estimate.tokens);
    const taken: string[] = [];
    try {
      await this.takeScope('actor', this.limits.actor, this.actorKey, estimate.tokens, taken);
      await this.takeScope('org', this.limits.org, this.orgKey, estimate.tokens, taken);
    } catch (error) {
      this.debitChain(-estimate.tokens);
      for (const key of taken) await this.store.add(key, -estimate.tokens);
      throw error;
    }
    return { tokens: estimate.tokens };
  }

  /**
   * One store scope, and only when its ceiling is DECLARED: every `llm()` / `agent()` / `hive()`
   * carries its caller's keys, so writing per key grew `MemoryBudgetStore` by one entry per caller
   * forever — and cost a shared store two writes a call — for counters no ceiling reads. Records
   * the key it took, so a refusal further on can give it back.
   */
  private async takeScope(
    scope: 'actor' | 'org',
    limit: number | undefined,
    key: string | undefined,
    tokens: number,
    taken: string[],
  ): Promise<void> {
    if (key === undefined || limit === undefined) return;
    const outcome: unknown = await this.store.take(key, tokens, limit);
    // The store is the app's: a shape it did not promise must be a coded refusal, never a
    // `TypeError` from reading `.taken` off `undefined` inside the reservation.
    assert(
      isBudgetTake(outcome),
      `BudgetStore.take("${key}") answered ${typeof outcome}, not { taken: boolean, spent: number }`,
      'return { taken, spent } from take(key, tokens, limit), spent being the counter before this take',
    );
    if (!outcome.taken) {
      throw new AiBudgetExceededError({
        scope: `${scope}:${key}`,
        requested: tokens,
        remaining: limit - outcome.spent,
        limit,
      });
    }
    taken.push(key);
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
    this.debitChain(tokens);
    // The keys `reserve` took — a scope with a declared ceiling — and no others, so a reconcile
    // never creates the counter `takeScope` declined to.
    for (const key of this.meteredKeys()) await this.store.add(key, tokens);
  }

  /** The store keys this ledger meters: a key whose scope declares a ceiling. */
  private meteredKeys(): readonly string[] {
    const keys: string[] = [];
    if (this.actorKey !== undefined && this.limits.actor !== undefined) keys.push(this.actorKey);
    if (this.orgKey !== undefined && this.limits.org !== undefined) keys.push(this.orgKey);
    return keys;
  }

  /** The in-memory half: this ledger's `request` counter and every ancestor's. */
  private debitChain(tokens: number): void {
    for (let l: BudgetLedger | undefined = this; l !== undefined; l = l.parent) {
      l.requestTokens += tokens;
    }
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

/**
 * Every declared token ceiling, proven to be a number. A limit is optional and an absent one is
 * "unlimited" by design — which is exactly why a `NaN` one is the dangerous value: it reads as a
 * declared ceiling everywhere (`report()`, a manifest row, a log line) and enforces nothing.
 */
function assertFiniteLimits(limits: BudgetLimits): BudgetLimits {
  for (const scope of ['request', 'tokensIn', 'actor', 'org'] as const) {
    const limit = limits[scope];
    if (limit !== undefined) finiteCount('the AI budget', scope, limit);
  }
  return limits;
}

function isBudgetTake(value: unknown): value is BudgetTake {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['taken'] === 'boolean' && Number.isFinite(record['spent']);
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
