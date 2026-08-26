// The LLM gateway: one entry point for every model call in an Ultimate app.
//
// Provider-agnostic (routes by model id), streaming, retrying with backoff on rate limits,
// budgeted, and cost-accounted in integer minor units. Everything an app does with a model
// goes through here, so budgets and accounting cannot be bypassed by a stray fetch.

import type { Random } from '@ultimat3/core';
import {
  backoffDelay,
  finiteCount,
  isRetryableStatus,
  isUltimateError,
  renderThrowable,
  stringField,
} from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { BudgetLimits, BudgetStore } from './budget';
import { BudgetLedger, currentBudget, estimateSpend, withBudget } from './budget';
import { AiProviderUnavailableError } from './errors';
import type { ModelId } from './models';
import { DEFAULT_MODEL } from './models';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';

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
 * these three field names are what an app writes in `createGateway({ retry })`, so renaming them
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

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

/** The one code `attempt` may collect into. Every other coded refusal is the caller's answer. */
const PROVIDER_UNAVAILABLE = 'X_AI_PROVIDER_UNAVAILABLE';

export interface CreateGatewayInput {
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
}

export interface Gateway {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  /** Open a budget scope. Nested gateway calls inside `fn` share one ledger. */
  scope<T>(input: { actorKey?: string; orgKey?: string }, fn: () => Promise<T>): Promise<T>;
  /** Accumulated cost of the ambient scope, or zero outside one. */
  spent(): Promise<Money>;
}

export function createGateway(input: CreateGatewayInput): Gateway {
  return new GatewayImpl(input);
}

class GatewayImpl implements Gateway {
  private readonly config: CreateGatewayInput;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Left `undefined` rather than defaulted, so `backoffDelay` owns the one fallback to `Math.random`. */
  private readonly random: Random | undefined;

  constructor(config: CreateGatewayInput) {
    this.config = config;
    this.retry = config.retry ?? DEFAULT_RETRY;
    // `attempts` is the retry loop's only exit condition and nothing screened it: `attempt <= NaN`
    // is false on the first comparison, so `attempt()` calls no provider at all and raises
    // `X_AI_PROVIDER_UNAVAILABLE` with an EMPTY attempt list — measured, "no provider could serve
    // model claude-opus-5 ()" for a provider that was never asked. A floor of 1 because the field
    // is documented as total attempts INCLUDING the first, so zero of them is not a policy.
    // `baseDelayMs` and `maxDelayMs` are deliberately not screened here: `backoffDelay` refuses a
    // non-finite one already, and a NEGATIVE base is clamped to a zero wait on purpose
    // (`gateway-backoff.test.ts` pins it), which a count check here would start refusing.
    finiteCount('createGateway', 'retry.attempts', this.retry.attempts, 1);
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = config.random;
  }

  scope<T>(input: { actorKey?: string; orgKey?: string }, fn: () => Promise<T>): Promise<T> {
    const ledger = new BudgetLedger({
      limits: this.config.budget ?? {},
      ...(input.actorKey !== undefined ? { actorKey: input.actorKey } : {}),
      ...(input.orgKey !== undefined ? { orgKey: input.orgKey } : {}),
      ...(this.config.budgetStore !== undefined ? { store: this.config.budgetStore } : {}),
    });
    return withBudget(ledger, fn);
  }

  async spent(): Promise<Money> {
    const ledger = currentBudget();
    if (ledger === undefined) return { minor: 0, currency: 'USD' };
    return (await ledger.report()).cost;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
    const resolved: GenerateRequest = { ...request, model, maxTokens: ceilingOf(request) };

    const cacheKey = cacheKeyFor(resolved);
    const cached = await this.config.cache?.get(cacheKey);
    if (cached !== undefined) {
      // A cache hit costs nothing, so it is deliberately NOT debited from the budget.
      return JSON.parse(cached) as GenerateResult;
    }

    // Reserve against the ESTIMATE before spending anything — tokens AND money, since a
    // cheap-in-tokens call on an expensive model is still a cost cap the app declared.
    // `record` below replaces the estimate with the provider's real counts.
    const ledger = currentBudget();
    // The estimate is DEBITED here, not merely checked: three concurrent calls under one ledger
    // all read the same `spent()` otherwise, all pass, and all three record against a ceiling
    // only one of them fitted.
    const reservation = await ledger?.reserve(estimateSpend(resolved));

    let result: GenerateResult;
    try {
      result = await this.attempt(model, (provider) => provider.generate(resolved));
    } catch (error) {
      // A call that never landed must not go on holding its reservation.
      await ledger?.release(reservation);
      throw error;
    }
    await ledger?.record(result.usage, result.cost, reservation);
    // A refusal is not an answer, so it is not cached. Storing one would keep serving a decision
    // the classifier might not make twice, long after the prompt that provoked it was fixed.
    if (result.stopReason !== 'refusal') {
      await this.config.cache?.set(cacheKey, JSON.stringify(result));
    }
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
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
    const provider = this.providerFor(model);

    const ledger = currentBudget();
    const reservation = await ledger?.reserve(estimateSpend(resolved));
    let settled = false;
    try {
      for await (const chunk of provider.stream(resolved)) {
        if (chunk.type !== 'done') {
          yield chunk;
          continue;
        }
        // Settled only once `record` has LANDED. Marking it first left a store that threw here
        // holding the reservation and half the record — the `finally` saw a settled stream.
        await ledger?.record(chunk.result.usage, chunk.result.cost, reservation);
        settled = true;
        yield { type: 'done', result: { ...chunk.result, provider: provider.name } };
      }
    } finally {
      // A stream that threw, or that its consumer abandoned, never reached `done` — so nothing
      // reconciled the reservation and it would hold the ceiling for the rest of the window.
      if (!settled) await ledger?.release(reservation);
    }
  }

  private providerFor(model: ModelId): Provider {
    const provider = this.config.providers.find((p) => p.models.includes(model));
    if (provider === undefined) {
      throw new AiProviderUnavailableError({
        model,
        attempts: this.config.providers.map((p) => `${p.name}: does not serve ${model}`),
        unserved: true,
      });
    }
    return provider;
  }

  /**
   * Try every provider that serves `model`, retrying each on a retryable failure with
   * exponential backoff plus full jitter (jitter matters: synchronised retries from N
   * workers reproduce the rate limit they are backing off from).
   *
   * Fallback here is across PROVIDERS serving one model, never across models — a silent model
   * swap changes what answered, what it cost and which eval baseline the answer belongs to. The
   * provider that did answer is stamped onto the result, so the fallback that DOES exist reaches
   * the span instead of being invisible.
   */
  private async attempt(
    model: ModelId,
    call: (provider: Provider) => Promise<GenerateResult>,
  ): Promise<GenerateResult> {
    const candidates = this.config.providers.filter((p) => p.models.includes(model));
    const failures: string[] = [];
    if (candidates.length === 0) {
      throw new AiProviderUnavailableError({
        model,
        attempts: [`no provider serves ${model}`],
        unserved: true,
      });
    }

    for (const provider of candidates) {
      for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
        try {
          return { ...(await call(provider)), provider: provider.name };
        } catch (error) {
          // A coded refusal that is NOT `X_AI_PROVIDER_UNAVAILABLE` reaches the caller verbatim.
          // Those are raised locally, before the socket opens — a missing credential, a control
          // the model does not accept — so the same rejection is waiting on every provider and
          // every attempt, which is the reason a 400 is not retried three lines below. Collecting
          // one into `X_AI_PROVIDER_UNAVAILABLE` discards its runnable `fix:` and answers the same
          // failure a different way from `stream`, which does not route through here at all.
          // A transport failure keeps the old path: `AiTransportError` IS
          // `X_AI_PROVIDER_UNAVAILABLE`, so "provider one 503'd, provider two timed out" still
          // collects across the candidates. `stringField` rather than `error.code`, because the
          // value came from an app's `Provider` and a property read on it can trap.
          if (isUltimateError(error) && stringField(error, 'code') !== PROVIDER_UNAVAILABLE) {
            throw error;
          }
          // `renderThrowable`, never `error.message` or `String(error)`: this line becomes the
          // `cause` of `X_AI_PROVIDER_UNAVAILABLE`, and a renderer that throws replaces the coded
          // refusal with a `TypeError` nothing downstream can catch by code. It bounds the text
          // too — a provider's 1MB body is not a cause.
          failures.push(`${provider.name}#${attempt}: ${renderThrowable(error)}`);
          if (!isRetryable(error) || attempt === this.retry.attempts) break;
          await this.sleep(backoffMs(this.retry, attempt, this.random));
        }
      }
    }
    throw new AiProviderUnavailableError({ model, attempts: failures });
  }
}

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
 * Full jitter: a uniform pick from [0, exponential], capped BEFORE the roll.
 *
 * The arithmetic is core's `backoffDelay` — this is the mapping from the gateway's own field names
 * onto it, and nothing else. Two things came with the delegation and neither is cosmetic: the
 * result is ROUNDED where this floored it (a shift of at most 1ms, and the same rounding
 * `@ultimat3/jobs` and `@ultimat3/realtime` already use), and a policy carrying a `NaN` — which is
 * what `Number(process.env.…)` answers for an unset variable — is REFUSED rather than clamped.
 * This paragraph said "waits 0" until 2026-08-26, which was the safe answer to the wrong question
 * and had already stopped being true: a schedule of zeroes still spins, it just spins on purpose,
 * so core's `backoffDelay` refuses a non-finite bound before it clamps and this gateway inherits
 * the refusal with the curve. `gateway-backoff.test.ts` pins both halves — the refusal, and the
 * negative base that IS still clamped to zero.
 */
export function backoffMs(policy: RetryPolicy, attempt: number, random?: Random): number {
  return backoffDelay({
    attempt,
    base: policy.baseDelayMs,
    max: policy.maxDelayMs,
    curve: 'exponential',
    jitter: 'full',
    random,
  });
}

/**
 * Retryable = the request was well formed and the provider was momentarily unable. A 400 is
 * never retried: the same body produces the same rejection and only burns the budget.
 *
 * The status half is core's `isRetryableStatus`, which is WIDER than the `429 || >= 500` this
 * gateway shipped: 408, 409 and 425 join it. Each is transient by construction — the server gave up
 * waiting for a body it never fully read, a concurrent writer won the round, the handshake was not
 * finished — so not retrying them was a gap rather than a policy, and one narrower table in one
 * package was how it stayed invisible. The `code` branch has no equivalent in core and stays here:
 * that table is HTTP status only, and a socket that timed out never produced one.
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  // A `Provider` is the APP's object, so the value it rejected with is one the framework did not
  // build: `e.status` is a getter call and, on a `Proxy`, a trap. A value that fights being read
  // cannot be SHOWN to be retryable, and this runs inside the catch block that has nothing left
  // to answer with — so it fails closed rather than raising.
  try {
    const e = error as { status?: unknown; code?: unknown };
    if (typeof e.status === 'number') return isRetryableStatus(e.status);
    return e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
  } catch {
    return false;
  }
}

/**
 * Cache key. Every field that changes the answer is in it — a key that ignores `effort` or
 * `system` would serve one prompt's answer for another.
 */
export function cacheKeyFor(request: GenerateRequest): string {
  return JSON.stringify({
    model: request.model,
    system: request.system ?? '',
    messages: request.messages,
    maxTokens: request.maxTokens,
    effort: request.effort ?? 'high',
    thinking: request.thinking ?? 'adaptive',
    tools: request.tools?.map((t) => t.name) ?? [],
    stop: request.stopSequences ?? [],
  });
}
