// Token and cost budgets, per request / per actor / per org.
//
// A budget REFUSES; it never truncates. A silently shortened prompt produces a confidently
// wrong answer that looks like a real one, and the caller has no signal anything happened.
// A thrown X_AI_BUDGET_EXCEEDED with the remaining count is strictly more useful.
//
// The carrier is an AsyncLocalStorage so nested calls (a RAG retrieval, a tool call that
// generates, an eval judge) all debit the same ledger without threading it through every
// signature. `node:async_hooks` is used directly because Bun implements it natively and the
// framework's ALS context is established at the HTTP boundary, above this package.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Money } from '@ultimat3/money';
import { AiBudgetExceededError } from './errors.ts';
import type { TokenUsage } from './provider.ts';
import { totalTokens } from './provider.ts';

/** Token ceilings. An omitted scope is unlimited — declare the ones that matter. */
export interface BudgetLimits {
  /** Ceiling for one `generate`/`stream` call, including its pre-flight estimate. */
  readonly request?: number;
  /** Ceiling for the acting identity across its whole window. */
  readonly actor?: number;
  /** Ceiling for the organisation across its whole window. */
  readonly org?: number;
}

/** Where cross-request counters live. Swap for Redis in a multi-process deployment. */
export interface BudgetStore {
  spent(key: string): Promise<number> | number;
  add(key: string, tokens: number): Promise<void> | void;
  reset(key?: string): Promise<void> | void;
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

  constructor(input: BudgetLedgerInput) {
    this.limits = input.limits;
    this.actorKey = input.actorKey;
    this.orgKey = input.orgKey;
    this.store = input.store ?? new MemoryBudgetStore();
    this.currency = input.currency ?? 'USD';
  }

  /**
   * Check `tokens` against every applicable scope BEFORE the call. Throws on the first scope
   * that cannot cover it, naming that scope — so the fix line points at one knob, not three.
   */
  async reserve(tokens: number): Promise<void> {
    this.assertScope('request', this.limits.request, this.requestTokens, tokens);
    if (this.limits.actor !== undefined && this.actorKey !== undefined) {
      const spent = await this.store.spent(this.actorKey);
      this.assertScope(`actor:${this.actorKey}`, this.limits.actor, spent, tokens);
    }
    if (this.limits.org !== undefined && this.orgKey !== undefined) {
      const spent = await this.store.spent(this.orgKey);
      this.assertScope(`org:${this.orgKey}`, this.limits.org, spent, tokens);
    }
  }

  /** Debit ACTUAL usage after the call, replacing the estimate `reserve` worked from. */
  async record(usage: TokenUsage, cost: Money): Promise<void> {
    const tokens = totalTokens(usage);
    this.requestTokens += tokens;
    this.costMinor += cost.minor;
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
}

const storage = new AsyncLocalStorage<BudgetLedger>();

/** Run `fn` with `ledger` as the ambient budget for everything it awaits. */
export function withBudget<T>(ledger: BudgetLedger, fn: () => Promise<T>): Promise<T> {
  return storage.run(ledger, fn);
}

/** The ambient ledger, or `undefined` outside a budget scope (spend is then unmetered). */
export function currentBudget(): BudgetLedger | undefined {
  return storage.getStore();
}
