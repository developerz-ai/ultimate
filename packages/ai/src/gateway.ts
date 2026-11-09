// The LLM gateway: one entry point for every model call in an Ultimate app.
//
// Provider-agnostic (routes by model id), streaming, retrying with backoff on rate limits,
// budgeted, and cost-accounted in integer minor units. Everything an app does with a model
// goes through here, so budgets and accounting cannot be bypassed by a stray fetch.

import type { Breaker, Random } from '@ultimat3/core';
import { fingerprint, finiteCount, logger, renderThrowable } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { billedOf } from './billed';
import type { BudgetKeys, BudgetLimits, BudgetReservation, BudgetStore } from './budget';
import {
  assertFiniteLimits,
  BudgetLedger,
  currentBudget,
  estimateSpend,
  withBudget,
} from './budget';
import type { GatewayBreakerOption } from './gateway-providers';
import {
  admittedProvider,
  attemptProviders,
  providerBreakers,
  streamVerdict,
} from './gateway-providers';
import { resolveModel } from './model-resolve';
import type { ModelId } from './models';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';
import type { SamplingWire } from './sampling';
import { ZERO_USAGE } from './wire';

/**
 * Response cache. Structurally satisfied by `@ultimat3/cache`'s memo/LRU tiers; declared as
 * an interface so the gateway is testable with a `Map` and so caching stays optional.
 */
export interface GatewayCache {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
}

/**
 * A gateway's retry budget. NOT core's `RetryPolicy`, and deliberately still its own declaration:
 * these three field names are what an app writes in `providerGateway({ retry })`, so renaming them
 * onto `base`/`max`/`jitter` would break every caller for no behaviour. What WAS a duplicate is the
 * arithmetic, and that is gone — `backoffMs` is core's `backoffDelay` with this shape mapped onto
 * it, so there is one curve in the framework and one place a jitter bug can live.
 */
export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly attempts: number;
  /** First backoff in ms; doubled per attempt with full jitter. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_GATEWAY_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export type { GatewayBreakerOption } from './gateway-providers';
export { backoffMs, DEFAULT_GATEWAY_BREAKER, isRetryable } from './gateway-providers';

export interface ProviderGatewayInput {
  /** Tried in order for a given model. First provider that lists the model wins. */
  readonly providers: readonly Provider[];
  readonly budget?: BudgetLimits;
  readonly budgetStore?: BudgetStore;
  readonly cache?: GatewayCache;
  readonly retry?: RetryPolicy;
  readonly defaultModel?: ModelId;
  /** Overridable so a test can run backoff without waiting. */
  sleep?(ms: number): Promise<void>;
  /**
   * The roll behind the backoff's jitter. Injectable for the same reason `sleep` is, and it was the
   * half that was missing: `Math.random()` read inline made this gateway's retry SCHEDULE provable
   * only by observing a range, so nothing asserted it and a jitter bug here would have shipped
   * green. Production never passes one.
   */
  readonly random?: Random | undefined;
  /**
   * One breaker per provider, on by default (`{ failures: 5, cooldownMs: 30_000 }`): a provider
   * whose retries ran out five passes running is skipped — no call, no sleep — until one probe
   * after the cooldown answers. Per process. `(provider) => breaker({ … })` to choose your own, `'off'` declines.
   */
  readonly breaker?: GatewayBreakerOption | undefined;
}

export interface Gateway {
  /** The wire formats of the providers serving `model` — what `ultimate.llm.sampling.ignored` is read from. */
  samplingWires?(model: ModelId): readonly SamplingWire[];
  /**
   * Whether a provider serving `model` would send a hinted request with a cache mark — so its
   * worst-case estimate prices the prompt at the write rate. Read by `agent()`'s `costPerRun`
   * check to estimate a turn exactly as the gateway's own reservation does; absent reads as no.
   */
  marksPromptCache?(model: ModelId): boolean;
  /**
   * The model a call with none declared runs on — `providerGateway({ defaultModel })`. Read by
   * `llm()` and `agent()` after the declaration and its prompt, so the app's choice is the one
   * fallback; absent, a call naming no model is refused (`X_AI_MODEL_UNRESOLVED`) — never routed to
   * a vendor the framework picked.
   */
  readonly defaultModel?: ModelId | undefined;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  /** Open a budget scope. Nested gateway calls inside `fn` share one ledger. */
  scope<T>(input: { actorKey?: string; orgKey?: string }, fn: () => Promise<T>): Promise<T>;
  /** Accumulated cost of the ambient scope, or zero outside one. */
  spent(): Promise<Money>;
  /**
   * A ledger over this gateway's own `budget`, for a call made with no `scope()` open — which is
   * every call `llm()`, `agent()` and `hive()` make, each passing `budgetKeysFor(ctx.actor)` so the
   * `actor` and `org` ceilings count the caller. Required: a gateway without it ran every such call
   * under no gateway ceiling at all.
   */
  callLedger(keys: BudgetKeys): BudgetLedger;
}

export function providerGateway(input: ProviderGatewayInput): Gateway {
  return new GatewayImpl(input);
}

class GatewayImpl implements Gateway {
  private readonly config: ProviderGatewayInput;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Left `undefined` rather than defaulted, so `backoffDelay` owns the one fallback to `Math.random`. */
  private readonly random: Random | undefined;
  private readonly gateOf: (provider: Provider) => Breaker | undefined;

  get defaultModel(): ModelId | undefined {
    return this.config.defaultModel;
  }

  constructor(config: ProviderGatewayInput) {
    this.config = config;
    this.retry = config.retry ?? DEFAULT_GATEWAY_RETRY;
    // `attempts` is the retry loop's only exit condition and nothing screened it: `attempt <= NaN`
    // is false on the first comparison, so `attempt()` calls no provider at all and raises
    // `X_AI_PROVIDER_UNAVAILABLE` with an EMPTY attempt list — measured, "no provider could serve
    // model <id> ()" for a provider that was never asked. A floor of 1 because the field
    // is documented as total attempts INCLUDING the first, so zero of them is not a policy.
    // `baseDelayMs` and `maxDelayMs` are deliberately not screened here: `backoffDelay` refuses a
    // non-finite one already, and a NEGATIVE base is clamped to a zero wait on purpose
    // (`gateway-backoff.test.ts` pins it), which a count check here would start refusing.
    finiteCount('gateway', 'retry.attempts', this.retry.attempts, 1);
    // Screened here, under the config's own key, rather than by the ledger `callLedger` builds:
    // that refused on the first CALL and named `the AI budget`, not the `gateway` to edit.
    if (config.budget !== undefined) assertFiniteLimits(config.budget, 'gateway', 'budget.');
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = config.random;
    this.gateOf = providerBreakers(config.breaker);
  }

  /**
   * `budget` held with no scope open. It was enforced ONLY inside `scope()`, which nothing in the
   * framework calls — so `providerGateway({ budget: { request: 100 } })` capped no call any app made.
   * A raw `generate` / `stream` outside any scope passes no keys: it has no caller to count.
   */
  callLedger(keys: BudgetKeys): BudgetLedger {
    return new BudgetLedger({
      limits: this.config.budget ?? {},
      ...(keys.actorKey !== undefined ? { actorKey: keys.actorKey } : {}),
      ...(keys.orgKey !== undefined ? { orgKey: keys.orgKey } : {}),
      ...(this.config.budgetStore !== undefined ? { store: this.config.budgetStore } : {}),
    });
  }

  scope<T>(input: BudgetKeys, fn: () => Promise<T>): Promise<T> {
    return withBudget(this.callLedger(input), fn);
  }

  async spent(): Promise<Money> {
    const ledger = currentBudget();
    if (ledger === undefined) return { minor: 0, currency: 'USD' };
    return (await ledger.report()).cost;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = resolveModel('gateway', request.model, this.config.defaultModel);
    const resolved: GenerateRequest = { ...request, model, maxTokens: ceilingOf(request) };

    const cacheKey = promptCacheKey(resolved);
    const cached = await this.config.cache?.get(cacheKey);
    if (cached !== undefined) {
      // A cache hit costs nothing, so it is deliberately NOT debited from the budget, and says so:
      // carrying the stored figures, a meter summing the run billed it a second time.
      return freeOf(JSON.parse(cached) as GenerateResult);
    }

    // Reserve against the ESTIMATE before spending anything — tokens AND money, since a
    // cheap-in-tokens call on an expensive model is still a cost cap the app declared.
    // `record` below replaces the estimate with the provider's real counts.
    const ledger = currentBudget() ?? this.callLedger({});
    // The estimate is DEBITED here, not merely checked: three concurrent calls under one ledger
    // all read the same `spent()` otherwise, all pass, and all three record against a ceiling
    // only one of them fitted.
    const reservation = await ledger?.reserve(
      estimateSpend(resolved, this.marksPromptCache(model)),
    );

    let result: GenerateResult;
    try {
      result = await attemptProviders({
        model,
        candidates: this.config.providers.filter((p) => p.models.includes(model)),
        retry: this.retry,
        sleep: this.sleep,
        random: this.random,
        gateOf: this.gateOf,
        call: (provider) => provider.generate(resolved),
      });
    } catch (error) {
      // A call that never landed must not go on holding its reservation — and one that DID land
      // and still failed (`billedOf`: the provider answered with something unusable) is recorded
      // as what it cost. Releasing it told the ledger a billed call was free.
      await settleFailure(ledger, reservation, error);
      throw error;
    }
    // The provider was PAID by now. Nothing below may turn that answer into a failure: a ledger
    // that cannot book it gives the reservation back and says so, and the answer is returned.
    try {
      await ledger?.record(result.usage, result.costExact ?? result.cost, reservation);
    } catch (error) {
      await ledger?.release(reservation).catch(() => undefined);
      logger.warn('ai.budget.record_failed', {
        provider: result.provider ?? 'unknown',
        error: renderThrowable(error),
      });
    }
    // A refusal is not an answer, so it is not cached. Storing one would keep serving a decision
    // the classifier might not make twice, long after the prompt that provoked it was fixed.
    if (result.stopReason !== 'refusal') await this.remember(cacheKey, result);
    return result;
  }

  /**
   * The cache write, AFTER the call was paid for and recorded. A throw here must not turn that
   * answer into a failure: the caller would retry and pay for it twice. Logged, and the answer kept.
   */
  private async remember(cacheKey: string, result: GenerateResult): Promise<void> {
    try {
      await this.config.cache?.set(cacheKey, JSON.stringify(result));
    } catch (error) {
      logger.warn('ai.cache.write_failed', { cacheKey, error: renderThrowable(error) });
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = resolveModel('gateway', request.model, this.config.defaultModel);
    const resolved: GenerateRequest = { ...request, model, maxTokens: ceilingOf(request) };

    // Routed BEFORE the reservation, not after it. `providerFor` throws for a registered model no
    // configured provider serves — an ordinary boot misconfiguration — and a debit taken first has
    // nothing to credit it back: the throw is outside the `finally` below, and the estimate has
    // already landed on the `BudgetStore`, which is per process and never expires. Five refused
    // streams and the org's ceiling is gone for the life of the process, with nothing ever sent.
    //
    // The streaming path does not retry AT ALL — not mid-flight, and not on the handshake either.
    // Mid-flight is the obvious one: the consumer has already been handed tokens, and replaying
    // from the top would duplicate them. The handshake is not separable from it here, because
    // `provider.stream()` is one call that yields — there is no point at which the connection is
    // open and no chunk has been delivered for a retry to hide behind. So `providerFor` picks the
    // single provider serving this model and that call stands or throws; `attempt`'s backoff and
    // its fallback across providers belong to `generate` alone. A caller that wants either uses
    // `generate`, or reconnects itself and knows what it has already shown.
    const { provider, ticket } = admittedProvider(model, this.config.providers, this.gateOf);
    const gate = this.gateOf(provider);
    let answered = false;

    const ledger = currentBudget() ?? this.callLedger({});
    let reservation: BudgetReservation | undefined;
    try {
      reservation = await ledger?.reserve(estimateSpend(resolved, this.marksPromptCache(model)));
    } catch (error) {
      // A refused reservation sent nothing: the half-open probe `admittedProvider` took goes back,
      // or the next healthy call would wait out a whole extra cooldown.
      gate?.released(ticket);
      throw error;
    }
    let settled = false;
    try {
      for await (const chunk of provider.stream(resolved)) {
        // The first chunk is the provider's verdict for its breaker: it answered.
        if (!answered) {
          answered = true;
          streamVerdict(gate, ticket, undefined);
        }
        if (chunk.type !== 'done') {
          yield chunk;
          continue;
        }
        // Settled only once `record` has LANDED. Marking it first left a store that threw here
        // holding the reservation and half the record — the `finally` saw a settled stream.
        const { usage, cost, costExact } = chunk.result;
        await ledger?.record(usage, costExact ?? cost, reservation);
        settled = true;
        yield { type: 'done', result: { ...chunk.result, provider: provider.name } };
      }
    } catch (error) {
      if (!answered) {
        answered = true;
        streamVerdict(gate, ticket, error);
      }
      // Thrown after the provider reported usage: the bill is recorded, exactly as `generate` does.
      // Only when nothing settled yet — a provider that throws AFTER its `done` chunk was already
      // recorded, and releasing again would credit the ledger a second time.
      if (!settled) {
        settled = true;
        await settleFailure(ledger, reservation, error);
      }
      throw error;
    } finally {
      // A stream its consumer abandoned never reached `done` — so nothing reconciled the
      // reservation and it would hold the ceiling for the rest of the window.
      if (!settled) await ledger?.release(reservation);
      // Abandoned before a chunk: the probe goes back, counting nothing.
      if (!answered) gate?.released(ticket);
    }
  }

  samplingWires(model: ModelId): readonly SamplingWire[] {
    return this.config.providers
      .filter((p) => p.models.includes(model))
      .flatMap((p) => (p.wire === undefined ? [] : [p.wire]));
  }

  /** Whether any provider serving `model` would send a hinted request with a cache mark. */
  marksPromptCache(model: ModelId): boolean {
    return this.config.providers.some(
      (p) => p.models.includes(model) && p.marksPromptCache?.(model) === true,
    );
  }
}

/** A failed call's reservation: reconciled against its bill when the failure carries one, else given back. */
async function settleFailure(
  ledger: BudgetLedger | undefined,
  reservation: BudgetReservation | undefined,
  error: unknown,
): Promise<void> {
  const billed = billedOf(error);
  if (billed === undefined) return ledger?.release(reservation);
  await ledger?.record(billed.usage, billed.cost, reservation);
}

/** The stored answer as a hit delivers it: no token spent, no money, in the currency it named. */
const freeOf = (stored: GenerateResult): GenerateResult => ({
  ...stored,
  usage: ZERO_USAGE,
  cost: { ...stored.cost, minor: 0 },
  ...(stored.costExact === undefined ? {} : { costExact: { ...stored.costExact, minor: 0 } }),
});

/**
 * The request's completion ceiling, screened at the one seam every model call in an app passes
 * through — `llm()`, `agent()`, an eval, a judge and a hand-built `generate()` alike.
 *
 * It is not the request that a `NaN` here breaks, and that is why it is refused before anything
 * else happens: `maxTokens` IS the pre-flight estimate, `want > remaining` is false for a `NaN`
 * want, and `BudgetLedger.debit` then writes it onto the ambient ledger and the per-process
 * `BudgetStore`. Both counters are `NaN` from then on, so every later comparison against them is
 * false too — one unscreened declaration turns off every actor and org ceiling in the process,
 * permanently, and reports nothing. Screened before the reservation, so the ledger never sees it.
 */
function ceilingOf(request: GenerateRequest): number {
  return finiteCount('the AI gateway', 'maxTokens', request.maxTokens, 1);
}

/**
 * Cache key. Every field that changes the answer is in it — a key that ignores `effort` or
 * `system` would serve one prompt's answer for another — and each tool WHOLE: every `llm()` tool
 * is named `respond`, so a key over names alone served an answer shaped for an old `output` schema
 * after the schema changed. Core's `fingerprint`, so key order never splits one request in two and
 * the width is the one every other sharing key in the framework has.
 */
export function promptCacheKey(request: GenerateRequest): string {
  return fingerprint({
    model: request.model,
    system: request.system ?? '',
    messages: request.messages,
    maxTokens: request.maxTokens,
    effort: request.effort ?? 'high',
    thinking: request.thinking ?? 'adaptive',
    tools: request.tools ?? [],
    stop: request.stopSequences ?? [],
    // Only when asked for: an absent knob must leave every key written before it existed as it was.
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  });
}
