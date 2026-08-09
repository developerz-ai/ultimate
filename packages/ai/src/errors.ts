// The X_* codes owned by @ultimat3/ai. Budget and threshold failures name the exact knob to
// change, because the caller is often a CI job with no human attached.

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const AI_ERROR_CODES = [
  'X_AI_PROVIDER_UNAVAILABLE',
  'X_AI_KEY_MISSING',
  'X_AI_REQUEST_INVALID',
  'X_AI_BUDGET_EXCEEDED',
  'X_AI_GATEWAY_MISSING',
  'X_AI_PROMPT_VERSION',
  'X_LLM_OUTPUT_INVALID',
  'X_EVAL_THRESHOLD',
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
  X_EVAL_THRESHOLD: 'an eval scored below its tolerance',
  X_VECTOR_DIM_MISMATCH: 'embedding dimensions differ from the store',
  X_VECTOR_SCOPE_WIDENED: 'a derived vector scope tried to leave its tenant',
};

// Titles must be registered for `format()` to render the contract's first line. Guarded
// because registering a code twice throws X_ERROR_CODE_DUPLICATE at import time.
for (const [code, title] of Object.entries(AI_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

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

/** An eval scored below its declared threshold. This is a test failure, not a warning. */
export class EvalThresholdError extends UltimateError {
  constructor(input: {
    eval: string;
    score: number;
    threshold: number;
    promptVersion: string;
    worst: readonly string[];
  }) {
    super({
      code: 'X_EVAL_THRESHOLD',
      cause:
        `eval "${input.eval}" scored ${input.score.toFixed(3)} against a threshold of ` +
        `${input.threshold.toFixed(3)} on prompt version ${input.promptVersion}; ` +
        `worst cases: ${input.worst.join(', ')}`,
      fix: `x ai eval ${input.eval} --verbose to see per-case scores, then fix the prompt or lower the threshold deliberately`,
      docs: docsFor('X_EVAL_THRESHOLD'),
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
