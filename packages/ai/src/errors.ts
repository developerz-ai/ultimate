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
  'X_AI_MODEL_UNKNOWN',
  'X_AI_PROMPT_SECRET',
  'X_LLM_OUTPUT_INVALID',
  'X_LLM_REFUSED',
  'X_LLM_TRUNCATED',
  'X_LLM_STREAM_INVALID',
  'X_AGENT_MAX_TURNS',
  'X_AGENT_TOOL_UNEXPOSED',
  'X_EVAL_THRESHOLD',
  'X_EVAL_BASELINE_MISSING',
  'X_EVAL_BASELINE_INVALID',
  'X_EVAL_MISSING',
  'X_EVAL_RECORDING',
  'X_VECTOR_DIM_MISMATCH',
  'X_VECTOR_SCOPE_WIDENED',
  'X_AI_EMBEDDER_INVALID',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const AI_ERROR_TITLES: Readonly<Record<AiErrorCode, string>> = {
  X_AI_PROVIDER_UNAVAILABLE: 'the model provider is unreachable',
  X_AI_KEY_MISSING: 'the provider API key is not set',
  X_AI_REQUEST_INVALID: 'the provider would reject this request',
  X_AI_BUDGET_EXCEEDED: 'a model call would exceed its budget',
  X_AI_GATEWAY_MISSING: 'an llm() action ran with no gateway installed',
  X_AI_PROMPT_VERSION: 'prompt version or slots are wrong',
  X_AI_MODEL_UNKNOWN: 'a model id nothing registered in the catalogue',
  X_AI_PROMPT_SECRET: 'a Secret was about to be rendered into a prompt',
  X_LLM_OUTPUT_INVALID: 'structured output failed its schema on the answer and the repair turn',
  X_LLM_REFUSED: 'the model declined the request',
  X_LLM_TRUNCATED: 'the answer hit its maxTokens ceiling before it was complete',
  X_LLM_STREAM_INVALID: 'a streamed answer failed its output schema, and a stream cannot repair',
  X_AGENT_MAX_TURNS: 'an agent hit its turn ceiling without answering',
  X_AGENT_TOOL_UNEXPOSED: 'an agent lists a tool that is not an MCP-exposed action',
  X_EVAL_THRESHOLD: 'an eval scored below its tolerance',
  X_EVAL_BASELINE_MISSING: 'an eval has no recorded baseline to gate against',
  X_EVAL_BASELINE_INVALID: 'a recorded baseline cannot be read',
  X_EVAL_MISSING: 'a prompt has no eval',
  X_EVAL_RECORDING: 'the gate ran with baseline recording switched on',
  X_VECTOR_DIM_MISMATCH: 'embedding dimensions differ from the store',
  X_VECTOR_SCOPE_WIDENED: 'a derived vector scope tried to leave its tenant',
  X_AI_EMBEDDER_INVALID: 'an Embedder returned fewer vectors than texts it was given',
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
 * A model id nothing put in the catalogue. This is what replaced the closed `ModelId` union: the
 * union made a company's own model id inexpressible, so the only way past `tsc` was to claim a
 * Claude id — and then `costOf` priced an internal model at Anthropic list rates and the budget
 * ledger reserved against a number belonging to a model nobody ran. A wrong id is still refused;
 * it is refused HERE, at the first read of the spec, instead of by making a right one impossible.
 */
export class AiModelUnknownError extends UltimateError {
  constructor(input: { model: string; registered: readonly string[] }) {
    super({
      code: 'X_AI_MODEL_UNKNOWN',
      cause:
        `model "${input.model}" has no registered spec, so nothing can price it ` +
        `(registered: ${input.registered.length > 0 ? input.registered.join(', ') : 'none'})`,
      // The `errors` gate blanks every interpolation, so the literal half alone has to name the
      // call. Which ids ARE registered is a fact of the failure, and cause is where facts live.
      fix: 'registerModel({ id, contextWindow, maxOutput, inputPerMillion, outputPerMillion, cacheMinimumTokens, reasoning }) at boot, before configureAi',
      docs: docsFor('X_AI_MODEL_UNKNOWN'),
      meta: { model: input.model },
    });
  }
}

/**
 * A `Secret` reached a prompt variable. `Secret` redacts by VALUE, so this would not have leaked
 * — it would have rendered `[redacted]` into the template and asked the model to reason about it,
 * which is a prompt that reads fine and means something else. The same class of failure as an
 * unfilled `{{slot}}`, and refused for the same reason: loudly, before a token is spent.
 */
export class AiPromptSecretError extends UltimateError {
  constructor(input: { ref: string; keys: readonly string[] }) {
    super({
      code: 'X_AI_PROMPT_SECRET',
      cause: `prompt "${input.ref}" was given a Secret in vars(): ${input.keys.join(', ')}`,
      fix: 'drop the key from vars() and from the template, or revealSecret(value) in vars() if the model genuinely has to read it',
      docs: docsFor('X_AI_PROMPT_SECRET'),
    });
  }
}

/**
 * A streamed answer did not satisfy its `output` schema. Distinct from `X_LLM_OUTPUT_INVALID`
 * because there is no repair turn to have failed: the consumer has already read the tokens, and
 * replaying a second answer over the top is two answers to one question. So a stream gets one
 * attempt, and the fix is either a looser schema or the non-streaming call that CAN repair.
 */
export class LlmStreamInvalidError extends UltimateError {
  constructor(input: { prompt: string; issues: string }) {
    super({
      code: 'X_LLM_STREAM_INVALID',
      cause: `streamed answer to prompt "${input.prompt}" failed its output schema: ${input.issues}`,
      fix: 'call the action instead of .stream() when the answer must satisfy a structured schema — a stream has already delivered its tokens and cannot take a repair turn',
      docs: docsFor('X_LLM_STREAM_INVALID'),
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
 * An `agent()` ran out of turns with no answer. Never a partial one: the loop's whole contract is
 * that it either satisfies `output` or says it did not, and a half-finished transcript returned as
 * a result is a model's working notes presented as a decision.
 *
 * Reaching the ceiling almost always means the loop has no exit condition — a tool that answers
 * the same thing every turn, or a prompt that never tells the model to finish. Raising the
 * ceiling on that spends more money on the same non-answer, which is why the fix names the prompt
 * before it names the number.
 */
export class AgentMaxTurnsError extends UltimateError {
  constructor(input: { agent: string; turns: number; calls: number }) {
    super({
      code: 'X_AGENT_MAX_TURNS',
      cause:
        `agent "${input.agent}" used all ${input.turns} turns and ${input.calls} tool calls ` +
        `without calling the respond tool`,
      fix: 'tell the template when to stop and answer through the respond tool, then bump its version — raise maxTurns only once the run demonstrably converges',
      docs: docsFor('X_AGENT_MAX_TURNS'),
      meta: { agent: input.agent, turns: input.turns },
    });
  }
}

/**
 * An `agent()` lists an action that is not an MCP-exposed tool. Refused at DECLARATION rather
 * than filtered at the call, because a silently dropped tool is the worst of both: the
 * declaration reads as if the model can call it, and the model is never offered it.
 *
 * `isMcpExposed` is the one predicate — an in-app agent and an external MCP client see exactly
 * the same catalogue, which is what keeps "there is no second authz system" true of the catalogue
 * too.
 */
export class AgentToolUnexposedError extends UltimateError {
  constructor(input: { agent: string; tools: readonly string[] }) {
    super({
      code: 'X_AGENT_TOOL_UNEXPOSED',
      cause: `agent "${input.agent}" lists tools no MCP surface exposes: ${input.tools.join(', ')}`,
      fix: 'add mcp: { expose: true } to the action named in cause, or drop it from the agent tools list',
      docs: docsFor('X_AGENT_TOOL_UNEXPOSED'),
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
    /**
     * A blessed model MORE capable than the one that refused, or `undefined` when the refusal
     * came from the most capable one this build knows. Retrying a refusal on a weaker model is
     * the one retry that cannot help, so the fix line drops the suggestion rather than inventing
     * a downgrade.
     */
    alternative: string | undefined;
    category: string | undefined;
    explanation: string | undefined;
  }) {
    super({
      code: 'X_LLM_REFUSED',
      cause:
        `model "${input.model}" declined prompt "${input.prompt}"` +
        `${input.category === undefined ? '' : ` (${input.category})`}` +
        `${input.explanation === undefined ? '' : `: ${input.explanation}`}`,
      fix:
        input.alternative === undefined
          ? `edit the template in definePrompt('${input.prompt}') and bump its version — no blessed model is more capable than '${input.model}'`
          : `set model: '${input.alternative}' on the llm() declaration, or edit the template in definePrompt('${input.prompt}') and bump its version`,
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
      fix: `set maxTokens: ${input.maxTokens * 2} on the llm() declaration, or drop fields from its output schema`,
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

/** A vector's length does not match the store's declared dimension. */
export class VectorDimMismatchError extends UltimateError {
  constructor(input: { store: string; expected: number; received: number }) {
    super({
      code: 'X_VECTOR_DIM_MISMATCH',
      cause: `store "${input.store}" expects ${input.expected} dimensions, got ${input.received}`,
      // Not `x ai reindex`: that command is PLANNED and throws, so a fix line naming it sends an
      // operator to a wall. A fix has to be performable today, which here means app code.
      fix: 'use the same embedder that created the store, or re-embed every record at the new width and upsert it',
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
      fix: `set dimension: ${input.received} on the embedder, then re-embed every record at that width and upsert it`,
      docs: docsFor('X_VECTOR_DIM_MISMATCH'),
    });
  }
}

/**
 * `embedOne` asked an `Embedder` for one vector and got none back — a batch-size invariant the
 * embedder itself broke, not a caller mistake. Distinct from `X_VECTOR_DIM_MISMATCH`: this fires
 * before there is a vector at all, so there is nothing yet to measure the width of.
 */
export class AiEmbedderInvalidError extends UltimateError {
  constructor(input: { embedder: string }) {
    super({
      code: 'X_AI_EMBEDDER_INVALID',
      cause: `embedder "${input.embedder}" returned no vector for a batch of one text`,
      // The `${…}` the fix used to carry is unreadable to the `errors` gate, which blanks every
      // interpolation — so the literal half alone has to name the call. Which embedder broke the
      // invariant is a fact of the failure, and the cause and `meta` are where facts live.
      fix: 'return one vector per input text from embed(), in the order the texts arrived',
      docs: docsFor('X_AI_EMBEDDER_INVALID'),
      meta: { embedder: input.embedder },
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

  constructor(input: {
    provider: string;
    status?: number | undefined;
    detail: string;
    /**
     * The env var holding THIS provider's key. Passed on the HTTP path, where a 401 has one fix:
     * a hardcoded `ANTHROPIC_API_KEY` was the whole fix line, so an OpenAI-format endpoint
     * rejecting a key sent an operator to set a variable it never reads.
     */
    envVar?: string | undefined;
  }) {
    super({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
      cause: `provider "${input.provider}" ${
        input.status === undefined ? 'failed' : `returned ${input.status}`
      }: ${input.detail}`,
      fix: fixForStatus(input.status, input.envVar),
      docs: docsFor('X_AI_PROVIDER_UNAVAILABLE'),
      meta: { provider: input.provider, status: input.status },
    });
    this.status = input.status;
  }
}

function fixForStatus(status: number | undefined, envVar: string | undefined): string {
  if (status === 401 || status === 403) {
    return envVar === undefined
      ? 'export the API key env var of the provider named in cause, with a key that is active for this model'
      : `export ${envVar}=<key> with a key that is active for this model`;
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
