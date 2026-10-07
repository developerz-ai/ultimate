// The model catalogue: an OPEN registry of limits, prices and the reasoning controls each model's
// request surface actually accepts. Mechanism only — the framework registers NO row: an app brings
// its models (`registerModel`, dated and sourced in its own repo) and picks its provider, so no
// vendor's id, price or ladder ships here to go stale or to be chosen for it (M12, 25.0.0).

import { assert, finiteCount, renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { AiModelUnknownError, AiRequestInvalidError } from './errors';

/**
 * A model id. A plain `string`, deliberately: the routing seam (`Provider`, `createGateway`) has
 * always been open, and a closed union over it made a company's own model untypeable.
 *
 * What replaces the union as the guard is `modelSpec()`: an id the app never registered is
 * `X_AI_MODEL_UNKNOWN` at the first read, naming the registered set. A wrong id is still caught —
 * at the call, with a fix line, rather than by making a correct id inexpressible.
 */
export type ModelId = string;

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

/** A non-text content block kind a model may accept (`AiContentBlock`'s `image` / `document`). */
export type ContentKind = 'image' | 'document';

/**
 * What one model's request surface accepts. Every field here is a 400 when it is sent to a model
 * that does not take it, which is why it is data on the spec rather than a rule in the request
 * builder: adding a fourth model is a row, not an `if`.
 */
export interface ModelReasoning {
  /** `output_config.effort`. A model without the control rejects it outright. */
  readonly effort: boolean;
  /** `thinking: {type:'adaptive'}`. Older models take a token budget this package never sends. */
  readonly adaptive: boolean;
  /**
   * Deepest effort at which thinking may be switched off; `undefined` = every effort, `'never'` =
   * none. `'never'` is a row, not an absence: on a model whose thinking is always on, an off switch
   * is a 400 at every effort, and refusing it locally names `effort` as the knob that replaced it.
   */
  readonly disableThinkingUpTo: Effort | 'never' | undefined;
  /**
   * How this model SPELLS "no up-front thinking" on the wire. Absent is `'disabled'`. A model that
   * answers `disabled` with a 400 pointing at `between_tools` (its lowest setting) states it here,
   * so the one `thinking: 'disabled'` stays one declaration rather than a per-model vocabulary.
   */
  readonly disabledThinking?: 'disabled' | 'between_tools';
}

export interface ModelSpec {
  readonly id: ModelId;
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Cost of one million input tokens, in minor units. */
  readonly inputPerMillion: Money;
  /** Cost of one million output tokens, in minor units. */
  readonly outputPerMillion: Money;
  /**
   * Cost of one million cache-READ tokens, in minor units. Absent is 0.1x `inputPerMillion`, the
   * standard multiplier — which is wrong for exactly the models whose vendor publishes its own (0.05x
   * and 0.025x exist), so a row with a vendor rate states it.
   */
  readonly cacheReadPerMillion?: Money;
  /**
   * Cost of one million cache-WRITE tokens at the 5-minute TTL, in minor units; absent is 1.25x
   * input. The 5-minute rate because it is the API's default TTL and this package never asks for
   * the 1-hour one (2x), and `usage` does not split the two.
   */
  readonly cacheWritePerMillion?: Money;
  /** Minimum cacheable prefix; a shorter prefix silently does not cache. */
  readonly cacheMinimumTokens: number;
  readonly reasoning: ModelReasoning;
  /**
   * The non-text blocks a message to this model may carry. Absent is TEXT ONLY, deliberately: an
   * app's own row for a text-only endpoint must not have an image sent to it, and the refusal
   * (`X_AI_CONTENT_UNSUPPORTED`) names this field, so a row that does take images is one edit.
   */
  readonly input?: readonly ContentKind[];
  /**
   * Which ladder this model is a rung on. A capability comparison only means anything inside one
   * — registration order across vendors is arrival order, not capability — so `moreCapableThan`
   * walks up within a family and stops at its boundary. Optional, and absent is its own family:
   * an app that registers its whole catalogue in the order it wants keeps comparing across all of
   * it, exactly as before this field existed.
   *
   * An app registering two vendors' rows is what makes this load-bearing: without it, the rung
   * above one vendor's top model is the other vendor's cheapest, and `X_LLM_REFUSED`'s fix line
   * tells an operator to paste a weaker model from a list their gateway may not serve at all.
   */
  readonly family?: string;
}

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
 * Add a model to the catalogue, or restate one that is already in it — the ONE way a model enters
 * it. The framework calls it for nothing: every row is the app's, written at boot (by convention in
 * the app's own `models.ts`, with the source and the date beside each number).
 *
 * Re-registering an id replaces its spec and keeps its rung. That is the negotiated-rate mechanism:
 * same id, new prices, and every `costOf`, every budget reservation and every recorded cost is that
 * number from then on.
 *
 * Registration order within a `family` is the capability ladder, most capable first: a model
 * appended to a family is its LEAST capable rung.
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
  assertOneCurrency(spec);
  if (spec.cacheReadPerMillion !== undefined) {
    finiteCount(SUBJECT, `${spec.id} cacheReadPerMillion.minor`, spec.cacheReadPerMillion.minor);
  }
  if (spec.cacheWritePerMillion !== undefined) {
    finiteCount(SUBJECT, `${spec.id} cacheWritePerMillion.minor`, spec.cacheWritePerMillion.minor);
  }
  registry.set(spec.id, spec);
  return spec;
}

/**
 * Every price on a row in ONE currency. `costOf` sums them into a single `Money` stamped with the
 * input price's currency, so a cache rate in another one would be added as if it were the same.
 */
function assertOneCurrency(spec: ModelSpec): void {
  const currency = spec.inputPerMillion.currency;
  const prices = {
    outputPerMillion: spec.outputPerMillion,
    cacheReadPerMillion: spec.cacheReadPerMillion,
    cacheWritePerMillion: spec.cacheWritePerMillion,
  };
  for (const [field, price] of Object.entries(prices)) {
    // X_INVARIANT, as `finiteCount`'s refusals of the same row are: a bad row, caught at boot.
    assert(
      price === undefined || price.currency === currency,
      `${SUBJECT} row "${spec.id}" prices ${field} in ${renderCauseValue(price?.currency)} and inputPerMillion in ${renderCauseValue(currency)}; costOf sums every price into one Money`,
      `registerModel({ ...spec, ${field}: { minor, currency: ${renderFixLiteral(currency, '<input currency>')} } })   # every price on a row in one currency`,
    );
  }
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

/** Test-only: empty the catalogue. Module state otherwise leaks between files. */
export function resetModels(): void {
  registry.clear();
}

const rankOf = (effort: Effort): number => EFFORTS.indexOf(effort);

/**
 * The model one rung ABOVE `model` IN ITS OWN FAMILY, among the rows the APP registered, or
 * `undefined` when it is already the most capable one that family holds — or nothing above it was
 * registered at all. The framework holds no rung of its own, so it never suggests a model the app
 * did not choose. Registration order is most-capable-first, so the ladder needs no second list;
 * `family` stops the walk at the boundary between two lists, where order is arrival, not capability.
 *
 * A refusal is only worth retrying UPWARD. `MODEL_IDS.find((id) => id !== refused)` answered a
 * refusal on the default model with the next entry DOWN, which is the one retry that cannot help:
 * the fix line told an operator to buy the same refusal from a weaker model.
 */
export function moreCapableThan(
  model: ModelId,
  declared: DeclaredReasoning = {},
): ModelId | undefined {
  const spec = registry.get(model);
  if (spec === undefined) return undefined;
  const ids = modelIds();
  // Up, but only within the model's own family: the entry before another family's top rung is the
  // previous family's bottom one, which is not a rung above anything.
  for (let at = ids.indexOf(model) - 1; at >= 0; at -= 1) {
    const above = ids[at];
    if (above === undefined || registry.get(above)?.family !== spec.family) continue;
    // A rung the SAME declaration cannot run on is not an answer: from a model with
    // `thinking: 'disabled'`, pasting one whose thinking is always on turns a refusal into an
    // `X_AI_REQUEST_INVALID` on every call. Skip it and keep climbing.
    if (acceptsReasoning(above, declared)) return above;
  }
  return undefined;
}

/** The reasoning controls a declaration named — what a suggested rung must also accept. */
export interface DeclaredReasoning {
  readonly effort?: Effort | undefined;
  readonly thinking?: ThinkingMode | undefined;
}

/** Whether `reasoningBody` would build this declaration's reasoning half for `model`. */
function acceptsReasoning(model: ModelId, declared: DeclaredReasoning): boolean {
  try {
    reasoningBody(model, declared.effort, declared.thinking);
    return true;
  } catch (error) {
    if (error instanceof AiRequestInvalidError) return false;
    throw error;
  }
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
      detail: `model "${model}" has no effort control; output_config.effort is a 400 on it (modelId: a registered id whose registerModel row has reasoning.effort: true)`,
      fix: 'agent({ …, model: modelId })   # or the llm() declaration, or definePrompt — or drop effort from definePrompt',
    });
  }
  // Only what the caller asked for. `output_config`, not a top-level `effort` — a top-level one
  // is silently ignored — and no block at all when nothing was requested, because a default sent
  // as a request is indistinguishable on the wire from a declaration that asked for it.
  if (effort !== undefined) body['output_config'] = { effort };

  if (!rules.adaptive) {
    if (thinking === 'adaptive') {
      throw new AiRequestInvalidError({
        detail: `model "${model}" predates adaptive thinking; a thinking block is a 400 on it (modelId: a registered id whose registerModel row has reasoning.adaptive: true)`,
        fix: 'agent({ …, model: modelId })   # or the llm() declaration, or definePrompt — or drop thinking from definePrompt',
      });
    }
    // No `thinking` field at all is exactly "no thinking" on a pre-4.6 model, so `disabled`
    // needs nothing sent — and sending a block it may not parse would be a 400 for no gain.
    return body;
  }

  if (thinking === 'disabled') {
    assertDisableAllowed(model, rules, effort ?? 'high');
    body['thinking'] = { type: rules.disabledThinking ?? 'disabled' };
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
  if (cap === 'never') {
    throw new AiRequestInvalidError({
      detail: `model "${model}" has thinking always on; thinking: 'disabled' is a 400 on it at every effort (modelId: a registered id whose registerModel row lets thinking be disabled)`,
      fix: `effort: 'low'   # in definePrompt, in place of thinking: 'disabled' — or model: modelId on the agent() or llm() declaration`,
    });
  }
  if (cap === undefined || rankOf(effort) <= rankOf(cap)) return;
  throw new AiRequestInvalidError({
    detail: `model "${model}" allows thinking: 'disabled' only at effort '${cap}' or below, not '${effort}'`,
    fix: `set effort: '${cap}' in definePrompt alongside thinking: 'disabled', or drop thinking from it`,
  });
}
