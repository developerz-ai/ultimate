// The error classes for @ultimat3/ai's core codes. Budget and threshold failures name the exact
// knob to change, because the caller is often a CI job with no human attached.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';
// The codes, their titles and the single registration call are `./error-codes`, imported here for
// that side effect.
import './error-codes';
import { budgetCeiling } from './budget-fix';
import type { ModelFallback, ModelFallbackClass } from './model-fallback';

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

/** Every configured provider refused or errored. Carries what each one said. */
export class AiProviderUnavailableError extends UltimateError {
  readonly fallback: ModelFallbackClass | undefined;
  readonly fellOver: readonly ModelFallback[] | undefined;

  constructor(input: {
    model: string;
    attempts: readonly string[];
    /**
     * True when no configured provider LISTS this model — a fact about `app.config.ts`, not about
     * the moment. It is the same code because a caller cannot act differently on it, and it carries
     * a per-instance `terminal` because a worker CAN: retrying it burns a whole policy proving the
     * configuration is still what it was. The call site states the fact; the class decides the
     * classification, so the retry vocabulary stays in one file.
     */
    readonly unserved?: boolean;
    /**
     * The declared class this failure falls over on (`./model-fallback`), set by the retry loop only
     * when EVERY collected failure had one. Absent: the next model in a chain is not asked.
     */
    readonly fallback?: ModelFallbackClass | undefined;
    /** Set when a whole `fallbackModels` chain failed: each model's attempt, for the run meter. */
    readonly fellOver?: readonly ModelFallback[] | undefined;
  }) {
    super({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
      cause: `no provider could serve model "${input.model}" (${input.attempts.join(' | ')})`,
      // Unserved is a gateway built without a provider for this model: the fix is the wiring.
      // Otherwise every provider listing it was asked and failed, each failure named in cause.
      fix:
        input.unserved === true
          ? `providerGateway({ providers: [provider] })   // apps/<app>/runtime.ts — a provider whose { models } lists '${input.model}'`
          : "x doctor --json   # egress from this process; each provider's failure is in cause — a 401 is its API key env var, a 5xx or an open breaker the provider's own outage",
      retry: input.unserved === true ? 'terminal' : undefined,
    });
    this.fallback = input.fallback;
    this.fellOver = input.fellOver;
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
    const ceiling = budgetCeiling(input);
    super({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause:
        `request needs ${input.requested} ${input.unit ?? 'tokens'} but scope ` +
        `"${input.scope}" has ${input.remaining} of ${input.limit} left`,
      fix: `budget: { ${ceiling.key}: ${ceiling.value} }   // on ${ceiling.where} — or shorten the prompt`,
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
      // The provider is the app's choice, so no vendor is the default (M12): the fix is the shape
      // and the cause names what `provider` is — one of the peers, or the app's own.
      cause: `an llm action on prompt "${input.prompt}" ran before any gateway was configured (provider: anthropicProvider({ models }) for the Anthropic Messages format, openAiProvider({ baseUrl, models }) for the OpenAI chat-completions format on any compatible server, or your own Provider)`,
      fix: 'export const runtime = { aiGateway: providerGateway({ providers: [provider] }) }   # apps/<app>/runtime.ts — in a test, installAiGateway(gateway) from @ultimat3/ai/adapter',
    });
  }
}

/**
 * A model id the app never registered. The framework registers none, so every id a call names —
 * any vendor's — is one the app's own `registerModel` wrote: priced, reserved and recorded by the
 * app's numbers, never by a list this package shipped. Refused HERE, at the first read of the spec
 * (`costOf`, the budget's estimate, the request builders), before anything is sent or charged.
 */
export class AiModelUnknownError extends UltimateError {
  constructor(input: { model: string; registered: readonly string[] }) {
    super({
      code: 'X_AI_MODEL_UNKNOWN',
      cause:
        `model "${input.model}" has no registered spec, so nothing can price or budget it — ` +
        `the framework registers no model of its own ` +
        `(registered: ${input.registered.length > 0 ? input.registered.join(', ') : 'none'})`,
      // The `errors` gate blanks every interpolation, so the literal half alone has to name the
      // call. Which ids ARE registered is a fact of the failure, and cause is where facts live.
      fix: 'registerModel({ id, contextWindow, maxOutput, inputPerMillion, outputPerMillion, cacheMinimumTokens, reasoning }) at boot, before configureAi',
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
      fix: `await action(input, { ctx })   // call "${input.prompt}" itself, not .stream(), when the answer must satisfy a structured schema — a stream has already delivered its tokens and cannot take a repair turn`,
    });
  }
}

/**
 * The model's answer failed the action's `output` schema on the first turn AND on the repair
 * turn that followed. Two failures is a disagreement between the prompt and the schema, not a
 * bad roll — a third attempt only spends money, so this throws instead of looping.
 */
export class LlmOutputInvalidError extends UltimateError {
  constructor(input: {
    prompt: string;
    attempts: number;
    issues: string;
    /** The last answer's issues, one per entry — what a job stores; `issues` is the cause's text. */
    list?: readonly string[];
  }) {
    super({
      code: 'X_LLM_OUTPUT_INVALID',
      meta: {
        prompt: input.prompt,
        attempts: input.attempts,
        issues: input.list ?? [input.issues],
      },
      cause:
        `prompt "${input.prompt}" returned output failing its schema on all ` +
        `${input.attempts} attempts: ${input.issues}`,
      fix: 'definePrompt({ id, version, template })   // describe the output shape in the template and bump its version — or widen `output` in the llm() declaration',
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
      fix: 'definePrompt({ id, version, template })   // tell the template when to stop and answer through the respond tool, then bump its version — raise maxTurns only once the run demonstrably converges',
      meta: { agent: input.agent, turns: input.turns },
    });
  }
}

/**
 * An `agent()` lists an action that is not an MCP-exposed tool. Refused at DECLARATION rather
 * than filtered at the call, because a silently dropped tool is the worst of both: the
 * declaration reads as if the model can call it, and the model is never offered it.
 *
 * `isAgentOffered` is the one predicate — an in-app agent sees every action an external MCP client
 * sees, plus the ones declared `agents: true` — so the catalogue is still declared at the action,
 * never filtered here.
 */
export class AgentToolUnexposedError extends UltimateError {
  constructor(input: { agent: string; tools: readonly string[] }) {
    super({
      code: 'X_AGENT_TOOL_UNEXPOSED',
      cause: `agent "${input.agent}" lists tools no MCP surface exposes: ${input.tools.join(', ')}`,
      fix: "inProcessTool({ name, description, input, execute })   # for a tool only this agent may call — or add mcp: { expose: false, agents: true } to the action named in cause for this app's agents alone, mcp: { expose: true } to offer it to MCP clients too, or drop it from the agent's tools",
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
     * A model the APP registered, in the same family, MORE capable than the one that refused —
     * or `undefined` when the app registered none above it. Retrying a refusal on a weaker model is
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
          ? `definePrompt({ id, version, template })   // edit the template of "${input.prompt}" and bump its version — no model your app registered in its family is more capable than '${input.model}'`
          : `model: '${input.alternative}'   // on the "${input.prompt}" declaration — or edit its prompt's template and bump the version`,
      meta: { model: input.model, category: input.category },
    });
  }
}

export class AiPromptVersionError extends UltimateError {
  constructor(input: { id: string; requested: string; available: readonly string[] }) {
    super({
      code: 'X_AI_PROMPT_VERSION',
      cause: `prompt "${input.id}" has no version "${input.requested}" (have: ${
        input.available.length > 0 ? input.available.join(', ') : 'none'
      })`,
      fix: `definePrompt({ id: '${input.id}', version, template })   // a new version after editing the template, then x manifest — getPrompt() asks for one cause lists`,
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
      fix: `{ ${input.missing.join(', ')} }   // returned from vars(): every {{variable}} the template declares — or remove it from the template`,
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
      fix: `{ dimension: ${input.expected} }   // the embedder that created "${input.store}" — or re-embed every record at the new width and upsert it`,
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
      fix: `vectorStore.scoped({ tenant: '${input.requested}' })   // derived from the unscoped store, never from the one bound to '${input.held}'`,
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
      fix: `{ dimension: ${input.received} }   // on the embedder "${input.embedder}", then re-embed every record at that width and upsert it`,
    });
  }
}

/**
 * An `Embedder` answered fewer vectors than it was given texts — a batch invariant the embedder
 * itself broke, not a caller mistake. Distinct from `X_VECTOR_DIM_MISMATCH`: this fires before
 * there is a vector at all, so there is nothing yet to measure the width of.
 *
 * The counts are optional because `embedOne` has nothing to report beyond "none for one", and its
 * cause has always read that way; `embedBatched` knows both numbers and states them.
 */
export class AiEmbedderInvalidError extends UltimateError {
  constructor(input: { embedder: string; expected?: number; received?: number }) {
    const counted =
      input.expected === undefined || input.received === undefined
        ? 'no vector for a batch of one text'
        : `${input.received} vectors for a batch of ${input.expected} texts`;
    super({
      code: 'X_AI_EMBEDDER_INVALID',
      cause: `embedder "${input.embedder}" returned ${counted}`,
      // The `${…}` the fix used to carry is unreadable to the `errors` gate, which blanks every
      // interpolation — so the literal half alone has to name the call. Which embedder broke the
      // invariant is a fact of the failure, and the cause and `meta` are where facts live.
      fix: 'embed: (texts) => Promise.all(texts.map(vectorFor))   // one vector per input text, in the order the texts arrived',
      meta: {
        embedder: input.embedder,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.received === undefined ? {} : { received: input.received }),
      },
    });
  }
}

/** No credential at call time. Named env var, because that is the whole fix. */
export class AiKeyMissingError extends UltimateError {
  constructor(input: { provider: string; envVar: string }) {
    super({
      code: 'X_AI_KEY_MISSING',
      cause: `provider "${input.provider}" has no API key: ${input.envVar} is unset and none was passed to its constructor`,
      fix: `export ${renderFixShellArg(input.envVar, '<API_KEY_VAR>')}=<key>, or pass { apiKey } when constructing the provider`,
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
