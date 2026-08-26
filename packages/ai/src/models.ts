// The model catalogue: an OPEN registry of limits, prices and the reasoning controls each model's
// request surface actually accepts. Open because a company's own gateway serves ids this package
// has never heard of — a closed union made them untypeable, so the only way past `tsc` was to
// claim a Claude id and be billed Anthropic list prices for a model nobody ran. As of 2026-08.

import { finiteCount } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { AiModelUnknownError, AiRequestInvalidError } from './errors';

/**
 * A model id. A plain `string`, deliberately: the routing seam (`Provider`, `createGateway`) has
 * always been open, and a closed union over it meant the VOCABULARY was not — `models:
 * ['llama-internal-70b']` did not typecheck, so `costOf` charged Anthropic prices for a model the
 * company does not use and the budget ledger reserved against the wrong number.
 *
 * What replaces the union as the guard is `modelSpec()`: an id nothing registered is
 * `X_AI_MODEL_UNKNOWN` at the first read, naming the registered set. A wrong id is still caught —
 * at the call, with a fix line, rather than by making a correct id inexpressible.
 */
export type ModelId = string;

/**
 * The models `AnthropicProvider` serves, in ladder order (most capable first). Its OWN list, not
 * the registry's: an app that registers an internal model must not have it routed to Anthropic.
 */
export const ANTHROPIC_MODEL_IDS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
] as const;

export const DEFAULT_MODEL: ModelId = 'claude-opus-5';

/** The built-in Anthropic rows' ladder. One `family` string, spelled once. */
const ANTHROPIC_FAMILY = 'anthropic';

/**
 * Reasoning depth, shallowest first — the order is load-bearing, because a model that caps where
 * thinking may be switched off compares against it. `xhigh` is the best setting for coding and
 * agentic work; `high` is the API default. Distinct from `maxTokens`, which is an enforced
 * ceiling the model cannot see.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Thinking mode. Adaptive lets the model decide depth per request and is the default on every
 * model that has it. There is no token budget to tune — `effort` replaced it.
 */
export type ThinkingMode = 'adaptive' | 'disabled';

/**
 * What one model's request surface accepts. Every field here is a 400 when it is sent to a model
 * that does not take it, which is why it is data on the spec rather than a rule in the request
 * builder: adding a fourth model is a row, not an `if`.
 */
export interface ModelReasoning {
  /** `output_config.effort`. Models older than 4.6 reject it outright. */
  readonly effort: boolean;
  /** `thinking: {type:'adaptive'}`. Older models take a token budget this package never sends. */
  readonly adaptive: boolean;
  /** Deepest effort that still accepts `thinking: 'disabled'`; `undefined` = every effort does. */
  readonly disableThinkingUpTo: Effort | undefined;
}

export interface ModelSpec {
  readonly id: ModelId;
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Cost of one million input tokens, in minor units. */
  readonly inputPerMillion: Money;
  /** Cost of one million output tokens, in minor units. */
  readonly outputPerMillion: Money;
  /** Minimum cacheable prefix; a shorter prefix silently does not cache. */
  readonly cacheMinimumTokens: number;
  readonly reasoning: ModelReasoning;
  /**
   * Which ladder this model is a rung on. A capability comparison only means anything inside one
   * — registration order across vendors is arrival order, not capability — so `moreCapableThan`
   * walks up within a family and stops at its boundary. Optional, and absent is its own family:
   * an app that registers its whole catalogue in the order it wants keeps comparing across all of
   * it, exactly as before this field existed.
   *
   * Registering the OpenAI-format rows after the Anthropic ones is what made this load-bearing:
   * the rung above `gpt-5.6-sol` was `claude-haiku-4-5`, so `X_LLM_REFUSED`'s fix line told an
   * operator to paste the cheapest model in the catalogue, from a vendor their gateway may not
   * serve at all.
   */
  readonly family?: string;
}

/**
 * A price per million tokens, in INTEGER MINOR UNITS. Token spend is money, and the house rule
 * applies to money wherever it comes from: never a float.
 */
const usd = (minor: number): Money => ({ minor, currency: 'USD' });

/**
 * Insertion order IS the capability ladder WITHIN a `family`, most capable first —
 * `moreCapableThan` is its only reader, exactly as it was when the ladder was a literal tuple.
 * Across families it is arrival order and means nothing. A `Map` because re-registering
 * an id REPLACES its spec in place without moving its rung, which is what makes a negotiated
 * enterprise rate expressible: one call, same id, new prices, same position in the ladder.
 */
const registry = new Map<ModelId, ModelSpec>();

/** Named in every bound refusal, so the fix names the call an app makes at boot. */
const SUBJECT = 'registerModel';

/**
 * Add a model to the catalogue, or restate one that is already in it. **The three built-ins
 * register through this same call**, at the bottom of this file — so the default path is the
 * app's path and there is exactly one way to put a model in the catalogue.
 *
 * Re-registering an id replaces its spec and keeps its rung. That is deliberate and it is the
 * negotiated-rate mechanism: an app whose contract prices `claude-opus-5` below list registers it
 * again with its own `inputPerMillion`/`outputPerMillion`, and every `costOf`, every budget
 * reservation and every recorded cost is that number from then on. Boot registers after this
 * module is imported, so the app always wins.
 *
 * A model appended after the built-ins is the LEAST capable rung, because that is what appending
 * to a most-capable-first list means. An app that wants its own ladder registers its whole
 * catalogue in the order it wants, re-registering the built-in ids it keeps.
 */
export function registerModel(spec: ModelSpec): ModelSpec {
  // Screened at the ONE seam every model in the catalogue passes through, and at boot, which is
  // the earliest a wrong row can be caught. Not a formality: `maxOutput` reaches the pre-flight
  // estimate through `Math.min(request.maxTokens, spec.maxOutput)` — which propagates a `NaN`
  // rather than screening it — and a `NaN` estimate passes every `want > remaining` budget check
  // and then writes itself onto the ledger and the per-process `BudgetStore`, where every later
  // comparison against it is false too. A price is the same story for the money ceiling, and
  // `costOf` answers confidently either way, so a row nobody can price is refused rather than
  // billed. Minor units are whole by the framework's money rule, so `finiteCount` is the check.
  finiteCount(SUBJECT, `${spec.id} contextWindow`, spec.contextWindow, 1);
  finiteCount(SUBJECT, `${spec.id} maxOutput`, spec.maxOutput, 1);
  finiteCount(SUBJECT, `${spec.id} cacheMinimumTokens`, spec.cacheMinimumTokens);
  finiteCount(SUBJECT, `${spec.id} inputPerMillion.minor`, spec.inputPerMillion.minor);
  finiteCount(SUBJECT, `${spec.id} outputPerMillion.minor`, spec.outputPerMillion.minor);
  registry.set(spec.id, spec);
  return spec;
}

/** Every registered id, in ladder order. */
export function modelIds(): readonly ModelId[] {
  return [...registry.keys()];
}

/**
 * Every registered spec, in ladder order.
 *
 * OFFERED, not yet published: nothing in the tree reads it. `@ultimat3/manifest` is tier 4 and so
 * is this package, so the consumer has to be `@ultimat3/cli` (tier 5) — a direct import would be a
 * sideways edge the boundary check refuses. The doc claimed `x manifest` consumed it, which is
 * exactly the kind of statement axiom 3 says is not a rule.
 */
export function registeredModels(): readonly ModelSpec[] {
  return [...registry.values()];
}

export function isModelRegistered(id: ModelId): boolean {
  return registry.has(id);
}

/**
 * The spec behind an id. The ONE read path, and the guard the closed union used to be: an
 * unregistered id throws here — at the pricing, request-building and streaming seams that all
 * call it — rather than silently pricing a foreign model at somebody else's rates.
 */
export function modelSpec(id: ModelId): ModelSpec {
  const spec = registry.get(id);
  if (spec === undefined) throw new AiModelUnknownError({ model: id, registered: modelIds() });
  return spec;
}

/**
 * Refuse an unregistered id without needing its spec. For a boot-time or `x doctor`-style check
 * AFTER registration has run; every request path reads `modelSpec` instead, and a declaration
 * cannot check at all — an `llm()` is evaluated at module scope, before boot registers anything.
 */
export function assertModel(id: ModelId): void {
  modelSpec(id);
}

/** Test-only reset back to the built-in catalogue. Module state otherwise leaks between files. */
export function resetModels(): void {
  registry.clear();
  registerBuiltInModels();
}

const rankOf = (effort: Effort): number => EFFORTS.indexOf(effort);

/**
 * The model one rung ABOVE `model` IN ITS OWN FAMILY, or `undefined` when it is already the most
 * capable one that family holds. Registration order is most-capable-first — "the others are
 * explicit downgrades" — so the ladder needs no second list to walk; `family` is what stops the
 * walk at the boundary between two vendors' lists, where order is arrival, not capability.
 *
 * A refusal is only worth retrying UPWARD. `MODEL_IDS.find((id) => id !== refused)` answered a
 * refusal on the default model with the next entry DOWN, which is the one retry that cannot help:
 * the fix line told an operator to buy the same refusal from a weaker model.
 */
export function moreCapableThan(model: ModelId): ModelId | undefined {
  const spec = registry.get(model);
  if (spec === undefined) return undefined;
  const ids = modelIds();
  // Up, but only within the model's own family: the entry before `gpt-5.6-sol` is
  // `claude-haiku-4-5`, which is not a rung above anything — it is the previous vendor's list.
  for (let at = ids.indexOf(model) - 1; at >= 0; at -= 1) {
    const above = ids[at];
    if (above !== undefined && registry.get(above)?.family === spec.family) return above;
  }
  return undefined;
}

/**
 * The reasoning half of a Messages body, shaped for one model. Everything it refuses, it refuses
 * LOCALLY with a real code — a round trip to learn a rule this file already states costs latency
 * and teaches nothing, and the provider's own message names the field rather than the fix.
 *
 * A control the caller never asked for is OMITTED rather than defaulted, so a model without the
 * knob stays callable. A control the caller did ask for is never silently dropped: a declaration
 * that reads `effort: 'max'` and quietly runs at the default is the failure nobody can see.
 */
export function reasoningBody(
  model: ModelId,
  effort: Effort | undefined,
  thinking: ThinkingMode | undefined,
): Record<string, unknown> {
  const rules = modelSpec(model).reasoning;
  const body: Record<string, unknown> = {};

  if (effort !== undefined && !rules.effort) {
    throw new AiRequestInvalidError({
      detail: `model "${model}" has no effort control; output_config.effort is a 400 on it`,
      fix: `drop effort from definePrompt, or set model: '${DEFAULT_MODEL}' on the llm() declaration`,
    });
  }
  // Only what the caller asked for. `output_config`, not a top-level `effort` — a top-level one
  // is silently ignored — and no block at all when nothing was requested, because a default sent
  // as a request is indistinguishable on the wire from a declaration that asked for it.
  if (effort !== undefined) body['output_config'] = { effort };

  if (!rules.adaptive) {
    if (thinking === 'adaptive') {
      throw new AiRequestInvalidError({
        detail: `model "${model}" predates adaptive thinking; a thinking block is a 400 on it`,
        fix: `set model: '${DEFAULT_MODEL}' on the llm() declaration, or drop thinking from definePrompt`,
      });
    }
    // No `thinking` field at all is exactly "no thinking" on a pre-4.6 model, so `disabled`
    // needs nothing sent — and sending a block it may not parse would be a 400 for no gain.
    return body;
  }

  if (thinking === 'disabled') {
    assertDisableAllowed(model, rules, effort ?? 'high');
    body['thinking'] = { type: 'disabled' };
    return body;
  }
  // Nothing asked for, nothing sent — the rule this file states, now the rule it follows.
  // Adaptive is the server's own default on every model that has it, so emitting the block
  // unrequested bought nothing and made a defaulted control indistinguishable on the wire from
  // a declared one.
  if (thinking === 'adaptive') body['thinking'] = { type: 'adaptive', display: 'summarized' };
  return body;
}

/** Some models cap the effort at which thinking may be switched off. Above the cap it is a 400. */
function assertDisableAllowed(model: ModelId, rules: ModelReasoning, effort: Effort): void {
  const cap = rules.disableThinkingUpTo;
  if (cap === undefined || rankOf(effort) <= rankOf(cap)) return;
  throw new AiRequestInvalidError({
    detail: `model "${model}" allows thinking: 'disabled' only at effort '${cap}' or below, not '${effort}'`,
    fix: `set effort: '${cap}' in definePrompt alongside thinking: 'disabled', or drop thinking from it`,
  });
}

/**
 * The blessed models. Opus 5 is the default; the others are explicit downgrades. IDs are exact
 * alias strings — never append a date suffix. Registered through the public `registerModel`, in
 * ladder order, so nothing about the built-in path is a private door an app cannot use.
 */
function registerBuiltInModels(): void {
  // $5 / $25 per MTok.
  registerModel({
    id: 'claude-opus-5',
    family: ANTHROPIC_FAMILY,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(500),
    outputPerMillion: usd(2_500),
    cacheMinimumTokens: 512,
    // Thinking is on by default here, and switching it OFF is legal only at `high` or below.
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: 'high' },
  });
  // $3 / $15 per MTok. The introductory rate is deliberately NOT modelled: a price that lapses on
  // a date makes every recorded cost depend on when it was read, and a budget that under-reports
  // spend after the lapse is a budget that is not one. List price over-reserves, which is safe.
  registerModel({
    id: 'claude-sonnet-5',
    family: ANTHROPIC_FAMILY,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(300),
    outputPerMillion: usd(1_500),
    cacheMinimumTokens: 1_024,
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: undefined },
  });
  // $1 / $5 per MTok. Pre-4.6, so it has neither knob: an `output_config.effort` or an adaptive
  // `thinking` block sent here is a 400 on every request, which is what made the cheap tier
  // uncallable while the request body was one shape for the whole catalogue.
  registerModel({
    id: 'claude-haiku-4-5',
    family: ANTHROPIC_FAMILY,
    contextWindow: 200_000,
    maxOutput: 64_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(500),
    cacheMinimumTokens: 4_096,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
}

registerBuiltInModels();
