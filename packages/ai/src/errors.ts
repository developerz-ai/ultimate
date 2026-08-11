// The X_* codes owned by @ultimat3/ai. Budget and threshold failures name the exact knob to
// change, because the caller is often a CI job with no human attached.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const AI_ERROR_CODES = [
  'X_AI_PROVIDER_UNAVAILABLE',
  'X_AI_KEY_MISSING',
  'X_AI_REQUEST_INVALID',
  'X_AI_BUDGET_EXCEEDED',
  'X_AI_GATEWAY_MISSING',
  'X_AI_PROMPT_VERSION',
  'X_LLM_OUTPUT_INVALID',
  'X_LLM_REFUSED',
  'X_LLM_TRUNCATED',
  'X_EVAL_THRESHOLD',
  'X_EVAL_BASELINE_MISSING',
  'X_EVAL_BASELINE_INVALID',
  'X_EVAL_MISSING',
  'X_VECTOR_DIM_MISMATCH',
  'X_VECTOR_SCOPE_WIDENED',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const AI_ERROR_TITLES: Readonly<Record<AiErrorCode, string>> = {
  X_AI_PROVIDER_UNAVAILABLE: 'the model provider is unreachable',
  X_AI_KEY_MISSING: 'the provider API key is not set',
  X_AI_REQUEST_INVALID: 'the provider would reject this request',
  X_AI_BUDGET_EXCEEDED: 'a model call would exceed its budget',
  X_AI_GATEWAY_MISSING: 'an llm() action ran with no gateway installed',
  X_AI_PROMPT_VERSION: 'prompt version or slots are wrong',
  X_LLM_OUTPUT_INVALID: 'structured output failed its schema on the answer and the repair turn',
  X_LLM_REFUSED: 'the model declined the request',
  X_LLM_TRUNCATED: 'the answer hit its maxTokens ceiling before it was complete',
  X_EVAL_THRESHOLD: 'an eval scored below its tolerance',
  X_EVAL_BASELINE_MISSING: 'an eval has no recorded baseline to gate against',
  X_EVAL_BASELINE_INVALID: 'a recorded baseline cannot be read',
  X_EVAL_MISSING: 'a prompt has no eval',
  X_VECTOR_DIM_MISMATCH: 'embedding dimensions differ from the store',
  X_VECTOR_SCOPE_WIDENED: 'a derived vector scope tried to leave its tenant',
};

// Titles must be registered for `format()` to render the contract's first line. Unconditional and
// in one call: every code above is owned here, so a second package claiming one is a real conflict
// that has to surface as X_ERROR_CODE_DUPLICATE rather than resolve to whoever imported first.
// `X_FORBIDDEN` (policy's) and `X_CURRENCY_MISMATCH` (money's) are thrown here but never titled.
registerErrorCodes(
  Object.fromEntries(Object.entries(AI_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: AiErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** Every configured provider refused or errored. Carries what each one said. */
export class AiProviderUnavailableError extends UltimateError {
  constructor(input: { model: string; attempts: readonly string[] }) {
    super({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
      cause: `no provider could serve model "${input.model}" (${input.attempts.join(' | ')})`,
      fix: 'check ai.providers in app.config.ts and the provider API key env var',
      docs: docsFor('X_AI_PROVIDER_UNAVAILABLE'),
    });
  }
}

/**
 * A request would exceed its token budget. Thrown BEFORE the call, so nothing is spent and
 * nothing is silently truncated — a truncated prompt produces a confidently wrong answer,
 * which is worse than a refusal.
 */
export class AiBudgetExceededError extends UltimateError {
  constructor(input: {
    scope: string;
    requested: number;
    remaining: number;
    limit: number;
    /** What the numbers count. Money scopes pass minor units so nothing reads as a float. */
    unit?: string;
  }) {
    super({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause:
        `request needs ${input.requested} ${input.unit ?? 'tokens'} but scope ` +
        `"${input.scope}" has ${input.remaining} of ${input.limit} left`,
      fix: `raise ai.budget for "${input.scope}" in app.config.ts, or shorten the prompt`,
      docs: docsFor('X_AI_BUDGET_EXCEEDED'),
    });
  }
}

/**
 * An `llm()` action ran with no gateway installed. Ambient rather than injected because a
 * declaration is authored at module scope, long before a provider exists — so the miss is a
 * boot-order fault, and naming the boot call is the whole fix.
 */
export class AiGatewayMissingError extends UltimateError {
  constructor(input: { prompt: string }) {
    super({
      code: 'X_AI_GATEWAY_MISSING',
      cause: `an llm action on prompt "${input.prompt}" ran before any gateway was configured`,
      fix: 'configureAi({ gateway: createGateway({ providers: [new AnthropicProvider()] }) }) at boot',
      docs: docsFor('X_AI_GATEWAY_MISSING'),
    });
  }
}

/**
 * The model's answer failed the action's `output` schema on the first turn AND on the repair
 * turn that followed. Two failures is a disagreement between the prompt and the schema, not a
 * bad roll — a third attempt only spends money, so this throws instead of looping.
 */
export class LlmOutputInvalidError extends UltimateError {
  constructor(input: { prompt: string; attempts: number; issues: string }) {
    super({
      code: 'X_LLM_OUTPUT_INVALID',
      cause:
        `prompt "${input.prompt}" returned output failing its schema on all ` +
        `${input.attempts} attempts: ${input.issues}`,
      fix: 'describe the output shape in the prompt template and bump its version, or widen `output` in the llm() declaration',
      docs: docsFor('X_LLM_OUTPUT_INVALID'),
    });
  }
}

/**
 * The provider's safety classifiers declined the request. A refusal is a 200 with no answer in
 * it, so it has to become an error HERE or it becomes an empty string somewhere downstream that
 * reads exactly like a model with nothing to say. Distinct from `X_LLM_OUTPUT_INVALID` because
 * the fix is different: nothing about the schema is wrong, and a repair turn buys a second
 * refusal at full price.
 */
export class LlmRefusedError extends UltimateError {
  constructor(input: {
    prompt: string;
    model: string;
    category: string | undefined;
    explanation: string | undefined;
  }) {
    super({
      code: 'X_LLM_REFUSED',
      cause:
        `model "${input.model}" declined prompt "${input.prompt}"` +
        `${input.category === undefined ? '' : ` (${input.category})`}` +
        `${input.explanation === undefined ? '' : `: ${input.explanation}`}`,
      fix: `rephrase the prompt template and bump its version, or set model: '<another model>' on the llm() declaration`,
      docs: docsFor('X_LLM_REFUSED'),
      meta: { model: input.model, category: input.category },
    });
  }
}

/**
 * The answer was cut off at the enforced ceiling and what arrived does not satisfy the schema.
 * Thrown instead of the repair turn on purpose: the ceiling does not move between attempts, so
 * a second answer truncates at exactly the same place and only spends money.
 */
export class LlmTruncatedError extends UltimateError {
  constructor(input: { prompt: string; maxTokens: number }) {
    super({
      code: 'X_LLM_TRUNCATED',
      cause: `prompt "${input.prompt}" was cut off at its ${input.maxTokens}-token ceiling`,
      fix: `raise maxTokens above ${input.maxTokens} on the llm() declaration, or shorten what the output schema asks for`,
      docs: docsFor('X_LLM_TRUNCATED'),
    });
  }
}

/** A prompt was requested at a version whose content hash does not match the registry. */
export class AiPromptVersionError extends UltimateError {
  constructor(input: { id: string; requested: string; available: readonly string[] }) {
    super({
      code: 'X_AI_PROMPT_VERSION',
      cause: `prompt "${input.id}" has no version "${input.requested}" (have: ${
        input.available.length > 0 ? input.available.join(', ') : 'none'
      })`,
      fix: 'bump the version in definePrompt after editing the template, then x manifest',
      docs: docsFor('X_AI_PROMPT_VERSION'),
    });
  }
}

/**
 * A prompt was rendered with variables its template does not accept. Shares
 * `X_AI_PROMPT_VERSION` because it is the same class of fault: the prompt artifact and the
 * call site disagree about the prompt's contract.
 */
export class AiPromptRenderError extends UltimateError {
  constructor(input: { ref: string; missing: readonly string[] }) {
    super({
      code: 'X_AI_PROMPT_VERSION',
      cause: `prompt "${input.ref}" was rendered without: ${input.missing.join(', ')}`,
      fix: 'pass every {{variable}} the template declares, or remove it from the template',
      docs: docsFor('X_AI_PROMPT_VERSION'),
    });
  }
}

/**
 * An eval scored further below its recorded baseline than its tolerance allows. The gate is the
 * DROP, not an absolute number — a model that got marginally worse everywhere is not the same
 * event as a prompt edit that broke one case, and only the second one is anybody's fault.
 *
 * This is a test failure, not a warning.
 */
export class EvalThresholdError extends UltimateError {
  constructor(input: {
    eval: string;
    score: number;
    baseline: number;
    tolerance: number;
    promptVersion: string;
    regressed: readonly string[];
  }) {
    super({
      code: 'X_EVAL_THRESHOLD',
      cause:
        `eval "${input.eval}" scored ${input.score.toFixed(3)} against a recorded baseline of ` +
        `${input.baseline.toFixed(3)} (tolerance ${input.tolerance.toFixed(3)}) on prompt ` +
        `version ${input.promptVersion}; regressed: ${input.regressed.join(', ')}`,
      fix: `x test ${input.eval} to see per-case scores, then fix the prompt — or ULTIMATE_EVAL_RECORD=1 x test eval to accept the new numbers as a reviewed diff`,
      docs: docsFor('X_EVAL_THRESHOLD'),
    });
  }
}

/**
 * An eval declared a baseline that has never been recorded. Not a pass: an eval with nothing to
 * compare against gates on nothing, and a step that cannot fail is a step that is not running.
 */
export class EvalBaselineMissingError extends UltimateError {
  constructor(input: { eval: string; path: string; reason: string; fix?: string }) {
    super({
      code: 'X_EVAL_BASELINE_MISSING',
      cause: `eval "${input.eval}" gates against ${input.path}, which ${input.reason}`,
      fix: input.fix ?? `ULTIMATE_EVAL_RECORD=1 x test eval, then commit ${input.path}`,
      docs: docsFor('X_EVAL_BASELINE_MISSING'),
    });
  }
}

/** A recorded baseline that cannot be read. Never treated as absent — that would erase a gate. */
export class EvalBaselineInvalidError extends UltimateError {
  constructor(input: { path: string; problem: string }) {
    super({
      code: 'X_EVAL_BASELINE_INVALID',
      cause: `the recorded baseline ${input.path} ${input.problem}`,
      fix: `ULTIMATE_EVAL_RECORD=1 x test eval to re-record ${input.path}`,
      docs: docsFor('X_EVAL_BASELINE_INVALID'),
    });
  }
}

/**
 * A registered prompt that no eval names. An unevaluated prompt is untested code that costs
 * money and answers users, so the gate fails on it exactly like an untyped module.
 */
export class EvalMissingError extends UltimateError {
  constructor(input: { prompt: string; id: string }) {
    super({
      code: 'X_EVAL_MISSING',
      cause: `prompt "${input.prompt}" has no eval`,
      fix: `defineEval({ name: '${input.id}', prompt, cases, scorers, tolerance, baseline }) beside the prompt, then ULTIMATE_EVAL_RECORD=1 x test eval`,
      docs: docsFor('X_EVAL_MISSING'),
    });
  }
}

/** A vector's length does not match the store's declared dimension. */
export class VectorDimMismatchError extends UltimateError {
  constructor(input: { store: string; expected: number; received: number }) {
    super({
      code: 'X_VECTOR_DIM_MISMATCH',
      cause: `store "${input.store}" expects ${input.expected} dimensions, got ${input.received}`,
      fix: 'use the same embedder that created the store, or x ai reindex to rebuild it',
      docs: docsFor('X_VECTOR_DIM_MISMATCH'),
    });
  }
}

/**
 * A derived vector scope tried to leave the tenant it was bound to. Scopes only ever tighten,
 * so this is always the same mistake: a request handler re-scoping the store it was handed
 * instead of deriving from the unscoped one. Widening silently would be a cross-tenant read.
 */
export class VectorScopeWidenedError extends UltimateError {
  constructor(input: { store: string; held: string; requested: string }) {
    super({
      code: 'X_VECTOR_SCOPE_WIDENED',
      cause:
        `store "${input.store}" is bound to tenant "${input.held}" and cannot be re-scoped ` +
        `to "${input.requested}"`,
      fix: `derive from the unscoped store instead: vectorStore.scoped({ tenant: '${input.requested}' })`,
      docs: docsFor('X_VECTOR_SCOPE_WIDENED'),
    });
  }
}

/**
 * An embedder returned vectors of a length other than the one it declares. Separate from the
 * store's mismatch because the fix is different: here the DECLARATION is wrong, and every
 * vector written before this call is the wrong width in whatever store accepted them.
 */
export class EmbedderDimMismatchError extends UltimateError {
  constructor(input: { embedder: string; expected: number; received: number }) {
    super({
      code: 'X_VECTOR_DIM_MISMATCH',
      cause:
        `embedder "${input.embedder}" is declared with ${input.expected} dimensions but the ` +
        `provider returned ${input.received}`,
      fix: `set dimension: ${input.received} on the embedder, then x ai reindex to rebuild the store`,
      docs: docsFor('X_VECTOR_DIM_MISMATCH'),
    });
  }
}

/** No credential at call time. Named env var, because that is the whole fix. */
export class AiKeyMissingError extends UltimateError {
  constructor(input: { provider: string; envVar: string }) {
    super({
      code: 'X_AI_KEY_MISSING',
      cause: `provider "${input.provider}" has no API key: ${input.envVar} is unset and none was passed to its constructor`,
      fix: `export ${input.envVar}=<key>, or pass { apiKey } when constructing the provider`,
      docs: docsFor('X_AI_KEY_MISSING'),
      meta: { provider: input.provider, envVar: input.envVar },
    });
  }
}

/**
 * A request the provider would answer with a 400, refused locally instead. Local because a
 * round trip to learn a rule the framework already knows is a round trip that costs latency
 * and teaches nothing — and the provider's own message names the field, not the fix.
 */
export class AiRequestInvalidError extends UltimateError {
  constructor(input: { detail: string; fix: string }) {
    super({
      code: 'X_AI_REQUEST_INVALID',
      cause: input.detail,
      fix: input.fix,
      docs: docsFor('X_AI_REQUEST_INVALID'),
    });
  }
}

/**
 * The provider answered with a non-2xx, an in-band error event, or a body nothing can be read
 * out of. Carries `status` as a real field so the gateway's retry policy can read it: a 429 or
 * a 503 is momentary, a 400 is the same rejection forever and retrying only burns the budget.
 */
export class AiTransportError extends UltimateError {
  readonly status: number | undefined;

  constructor(input: { provider: string; status?: number | undefined; detail: string }) {
    super({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
      cause: `provider "${input.provider}" ${
        input.status === undefined ? 'failed' : `returned ${input.status}`
      }: ${input.detail}`,
      fix: fixForStatus(input.status),
      docs: docsFor('X_AI_PROVIDER_UNAVAILABLE'),
      meta: { provider: input.provider, status: input.status },
    });
    this.status = input.status;
  }
}

function fixForStatus(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return 'export ANTHROPIC_API_KEY=<key> with a key that is active for this model';
  }
  if (status === 429) {
    return 'lower concurrency or raise the provider rate limit; the gateway already backs off';
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return 'fix the request named in cause — shorten the prompt, or correct the tool schema';
  }
  if (status !== undefined) return 'retry; if it persists check the provider status page';
  return 'check egress from this process (x doctor --json), then the provider status page';
}
