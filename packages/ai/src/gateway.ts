// The LLM gateway: one entry point for every model call in an Ultimate app.
//
// Provider-agnostic (routes by model id), streaming, retrying with backoff on rate limits,
// budgeted, and cost-accounted in integer minor units. Everything an app does with a model
// goes through here, so budgets and accounting cannot be bypassed by a stray fetch.

import type { Money } from '@ultimat3/money';
import type { BudgetLimits, BudgetStore } from './budget';
import { BudgetLedger, currentBudget, withBudget } from './budget';
import { AiProviderUnavailableError } from './errors';
import type {
  GenerateRequest,
  GenerateResult,
  ModelId,
  Provider,
  StreamChunk,
} from './provider';
import { DEFAULT_MODEL, estimateTokens } from './provider';

/**
 * Response cache. Structurally satisfied by `@ultimat3/cache`'s memo/LRU tiers; declared as
 * an interface so the gateway is testable with a `Map` and so caching stays optional.
 */
export interface GatewayCache {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
}

export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly attempts: number;
  /** First backoff in ms; doubled per attempt with full jitter. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

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

  constructor(config: CreateGatewayInput) {
    this.config = config;
    this.retry = config.retry ?? DEFAULT_RETRY;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    const resolved: GenerateRequest = { ...request, model };

    const cacheKey = cacheKeyFor(resolved);
    const cached = await this.config.cache?.get(cacheKey);
    if (cached !== undefined) {
      // A cache hit costs nothing, so it is deliberately NOT debited from the budget.
      return JSON.parse(cached) as GenerateResult;
    }

    // Reserve against the ESTIMATE before spending anything. `record` below replaces it
    // with the provider's real counts.
    const ledger = currentBudget();
    await ledger?.reserve(estimateTokens(resolved));

    const result = await this.attempt(model, (provider) => provider.generate(resolved));
    await ledger?.record(result.usage, result.cost);
    await this.config.cache?.set(cacheKey, JSON.stringify(result));
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = request.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
    const resolved: GenerateRequest = { ...request, model };
    const ledger = currentBudget();
    await ledger?.reserve(estimateTokens(resolved));

    // A stream is not retried mid-flight: the consumer has already seen tokens, and
    // replaying from the top would duplicate them. Only the handshake retries.
    const provider = this.providerFor(model);
    for await (const chunk of provider.stream(resolved)) {
      if (chunk.type === 'done') await ledger?.record(chunk.result.usage, chunk.result.cost);
      yield chunk;
    }
  }

  private providerFor(model: ModelId): Provider {
    const provider = this.config.providers.find((p) => p.models.includes(model));
    if (provider === undefined) {
      throw new AiProviderUnavailableError({
        model,
        attempts: this.config.providers.map((p) => `${p.name}: does not serve ${model}`),
      });
    }
    return provider;
  }

  /**
   * Try every provider that serves `model`, retrying each on a retryable failure with
   * exponential backoff plus full jitter (jitter matters: synchronised retries from N
   * workers reproduce the rate limit they are backing off from).
   */
  private async attempt<T>(model: ModelId, call: (provider: Provider) => Promise<T>): Promise<T> {
    const candidates = this.config.providers.filter((p) => p.models.includes(model));
    const failures: string[] = [];
    if (candidates.length === 0) {
      throw new AiProviderUnavailableError({ model, attempts: [`no provider serves ${model}`] });
    }

    for (const provider of candidates) {
      for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
        try {
          return await call(provider);
        } catch (error) {
          failures.push(`${provider.name}#${attempt}: ${messageOf(error)}`);
          if (!isRetryable(error) || attempt === this.retry.attempts) break;
          await this.sleep(backoffMs(this.retry, attempt));
        }
      }
    }
    throw new AiProviderUnavailableError({ model, attempts: failures });
  }
}

/** Full jitter: a uniform pick from [0, exponential], capped. */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  const ceiling = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  return Math.floor(Math.random() * ceiling);
}

/**
 * Retryable = the request was well formed and the provider was momentarily unable. A 400 is
 * never retried: the same body produces the same rejection and only burns the budget.
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { status?: unknown; code?: unknown };
  if (typeof e.status === 'number') return e.status === 429 || e.status >= 500;
  return e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
