// Single responsibility: which provider the gateway asks, how often, and when it stops asking one
// that is down. The retry loop across providers, the backoff mapping, the retryable test, and one
// core `breaker()` per provider: a provider down for an hour cost `attempts` calls plus backoff on
// EVERY call; behind its breaker it costs `attempts × failures` per cooldown, then none.

import type { Breaker, BreakerTicket, Random } from '@ultimat3/core';
import {
  backoffDelay,
  breaker,
  isRetryableStatus,
  isUltimateError,
  renderThrowable,
  settleWith,
  stringField,
  tryUseContext,
} from '@ultimat3/core';
import { AiProviderUnavailableError } from './errors';
import type { RetryPolicy } from './gateway';
import type { ModelId } from './models';
import type { GenerateResult, Provider } from './provider';

/**
 * `providerGateway({ breaker })`: the breaker each provider sits behind, by a function of the
 * provider (one spelling: build it with core's `breaker()`); `'off'` declines. Absent, one per
 * provider name at `DEFAULT_GATEWAY_BREAKER`.
 */
export type GatewayBreakerOption = ((provider: Provider) => Breaker) | 'off';

/** Five consecutive exhausted passes open a provider for thirty seconds. */
export const DEFAULT_GATEWAY_BREAKER = Object.freeze({ failures: 5, cooldownMs: 30_000 });

/** The one code `attempt` may collect into. Every other coded refusal is the caller's answer. */
const PROVIDER_UNAVAILABLE = 'X_AI_PROVIDER_UNAVAILABLE';

/**
 * Full jitter: a uniform pick from [0, exponential], capped BEFORE the roll — core's
 * `backoffDelay` with the gateway's own field names mapped onto it, and nothing else.
 * `gateway-backoff.test.ts` pins the refusal of a non-finite bound and the clamped negative base.
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
 * A transport that never produced a response. Node spells these `ETIMEDOUT`/`ECONNRESET`; Bun's
 * `fetch` spells a refused, dropped or unopenable connection `ConnectionRefused`,
 * `ConnectionClosed` and `FailedToOpenSocket`.
 */
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

/**
 * Retryable = the request was well formed and the provider was momentarily unable. A 400 is
 * never retried: the same body produces the same rejection and only burns the budget. The status
 * half is core's `isRetryableStatus`; the `code` half has no equivalent in core (a socket that
 * timed out never produced a status).
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  // A `Provider` is the APP's object: `e.status` is a getter call and, on a `Proxy`, a trap. A
  // value that fights being read cannot be SHOWN to be retryable, so it fails closed.
  try {
    const e = error as { status?: unknown; code?: unknown };
    if (typeof e.status === 'number') return isRetryableStatus(e.status);
    return typeof e.code === 'string' && RETRYABLE_TRANSPORT_CODES.has(e.code);
  } catch {
    return false;
  }
}

/** One breaker per provider name, made on first use. `undefined` under `'off'`. */
export function providerBreakers(
  option: GatewayBreakerOption | undefined,
): (provider: Provider) => Breaker | undefined {
  if (option === 'off') return () => undefined;
  if (option !== undefined) return option;
  const gates = new Map<string, Breaker>();
  return (provider) => {
    let gate = gates.get(provider.name);
    if (gate === undefined) {
      gate = breaker({ name: `ai.${provider.name}`, ...DEFAULT_GATEWAY_BREAKER });
      gates.set(provider.name, gate);
    }
    return gate;
  };
}

/** A pass that ran out: a failure about the provider, unless the caller went away meanwhile. */
const exhausted = (gate: Breaker | undefined, ticket: BreakerTicket | undefined): void => {
  if (tryUseContext()?.signal.aborted === true) gate?.released(ticket);
  else gate?.failed(ticket);
};

export interface AttemptInput {
  readonly model: ModelId;
  readonly candidates: readonly Provider[];
  readonly retry: RetryPolicy;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: Random | undefined;
  readonly gateOf: (provider: Provider) => Breaker | undefined;
  readonly call: (provider: Provider) => Promise<GenerateResult>;
}

/**
 * Try every provider that serves the model, retrying each on a retryable failure with full-jitter
 * backoff, skipping one whose breaker is open — no call, no sleep. Fallback is across PROVIDERS
 * serving one model, never across models: a silent model swap changes what answered and what it
 * cost. The provider that answered is stamped onto the result.
 */
export async function attemptProviders(input: AttemptInput): Promise<GenerateResult> {
  const { model, retry } = input;
  const failures: string[] = [];
  if (input.candidates.length === 0) {
    throw new AiProviderUnavailableError({
      model,
      attempts: [`no provider serves ${model}`],
      unserved: true,
    });
  }
  for (const provider of input.candidates) {
    const gate = input.gateOf(provider);
    const ticket = gate?.admit();
    if (gate !== undefined && ticket === undefined) {
      failures.push(`${provider.name}: breaker open`);
      continue;
    }
    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      try {
        const answer = { ...(await input.call(provider)), provider: provider.name };
        gate?.succeeded(ticket);
        return answer;
      } catch (error) {
        // A coded refusal that is NOT `X_AI_PROVIDER_UNAVAILABLE` reaches the caller verbatim: it
        // was raised before the socket opened, and the same rejection waits on every provider. The
        // provider did not fail, so its breaker hears an answer. `stringField`, never `error.code`:
        // the value came from an app's `Provider`, and a property read on it can trap.
        if (isUltimateError(error) && stringField(error, 'code') !== PROVIDER_UNAVAILABLE) {
          // The breaker's own verdict: a caller's abort (`X_ABORTED`, `X_DRAINING`) gives the probe
          // back and closes nothing; a local refusal is the provider answering.
          if (gate !== undefined) settleWith(gate, gate.judge(error), ticket);
          throw error;
        }
        // `renderThrowable`: this line becomes a `cause`, and a renderer that throws would replace
        // the coded refusal with a `TypeError`. It bounds a provider's 1 MB body too.
        failures.push(`${provider.name}#${attempt}: ${renderThrowable(error)}`);
        if (!isRetryable(error)) {
          // A 400 is the provider answering: it is up, and a 400 never opens its breaker.
          gate?.succeeded(ticket);
          break;
        }
        if (attempt === retry.attempts) {
          exhausted(gate, ticket);
          break;
        }
        await input.sleep(backoffMs(retry, attempt, input.random));
      }
    }
  }
  throw new AiProviderUnavailableError({ model, attempts: failures });
}

/**
 * The provider a STREAM goes to: the first serving the model whose breaker admits it, with its
 * ticket. A stream never retries (tokens already handed over cannot be replayed).
 */
export function admittedProvider(
  model: ModelId,
  providers: readonly Provider[],
  gateOf: (provider: Provider) => Breaker | undefined,
): { readonly provider: Provider; readonly ticket: BreakerTicket | undefined } {
  const candidates = providers.filter((p) => p.models.includes(model));
  if (candidates.length === 0) {
    throw new AiProviderUnavailableError({
      model,
      attempts: providers.map((p) => `${p.name}: does not serve ${model}`),
      unserved: true,
    });
  }
  for (const provider of candidates) {
    const gate = gateOf(provider);
    if (gate === undefined) return { provider, ticket: undefined };
    const ticket = gate.admit();
    if (ticket !== undefined) return { provider, ticket };
  }
  throw new AiProviderUnavailableError({
    model,
    attempts: candidates.map((p) => `${p.name}: breaker open`),
  });
}

/** A stream's first chunk or first throw is the provider's verdict; an abandoned one says nothing. */
export function streamVerdict(
  gate: Breaker | undefined,
  ticket: BreakerTicket | undefined,
  error: unknown,
): void {
  if (gate === undefined) return;
  if (error === undefined) gate.succeeded(ticket);
  else if (tryUseContext()?.signal.aborted === true) gate.released(ticket);
  else if (isRetryable(error) || stringField(error, 'code') === PROVIDER_UNAVAILABLE) {
    gate.failed(ticket);
  } else settleWith(gate, gate.judge(error), ticket);
}
