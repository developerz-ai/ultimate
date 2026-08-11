/**
 * `llm()` — a model call declared as an `action`, NOT a ninth primitive.
 *
 * The eight primitives are the whole vocabulary. A model call is a server-authoritative
 * operation with an input schema, an output schema and a policy, which is the definition of
 * an `action` — so this file is a FACTORY over `action()`, never a new kind of thing. That is
 * why `summarize.tool()`, `.openapi()`, `.client()`, `.job()` and `.contract()` all exist
 * without a line here: the value is an action, so it projects like one, and an app gains an
 * MCP tool backed by a model the moment it declares one.
 *
 * What the factory adds is the model half: the prompt is rendered from the parsed input, the
 * `output` schema is projected into a tool the model must answer through, a per-call budget is
 * reserved before a token is spent, and a near-duplicate prompt hits the semantic cache.
 */

import type { Action, ActionMcp, ActionPolicy } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { withSpan } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, toMcpInputSchema, validateAsync } from '@ultimat3/schema';
import { parseDuration } from '@ultimat3/time';
import type { BudgetLimits } from './budget';
import { BudgetLedger, currentBudget, withBudget } from './budget';
import { embedOne, fnv1a } from './embeddings';
import { LlmOutputInvalidError, LlmRefusedError, LlmTruncatedError } from './errors';
import type { ModelId } from './models';
import { DEFAULT_MODEL } from './models';
import type { Prompt, PromptVars } from './prompt';
import type { AiMessage, GenerateRequest, GenerateResult } from './provider';
import { aiEmbedder, aiGateway, semanticCacheFor } from './runtime';
import type { LlmTool } from './tools';

/** The tool the model answers through. One name, so the reader never has to guess. */
const RESPOND = 'respond';

/** Two attempts total: the answer, then one repair turn. See `LlmOutputInvalidError`. */
const ATTEMPTS = 2;

/**
 * Output ceiling when the declaration omits one. Not the model's maximum — a 128k ceiling
 * makes the worst-case cost estimate so large that every `costPerCall` budget refuses.
 */
const DEFAULT_MAX_TOKENS = 4_096;

export interface LlmSemanticCache<TParsed> {
  /** Cosine floor. Below ~0.9 unrelated prompts collide and the cache answers the wrong one. */
  readonly threshold?: number;
  /** Entry lifetime as a duration string — `'7d'`, `'12h'`. `@ultimat3/time` owns the grammar. */
  readonly ttl?: string;
  /**
   * Partition key, from the parsed input. Each scope is a separate cache: cosine similarity
   * has no notion of a tenant, so a shared cache answers one tenant with another's data.
   */
  readonly scope?: (input: TParsed) => string;
}

export interface LlmCache<TParsed> {
  readonly semantic: LlmSemanticCache<TParsed>;
  // `05-caching.md` also declares `invalidates: [tag.post]` here. It is deliberately absent
  // until `@ultimat3/cache`'s fan-out can reach something that is not a `CacheTier`: storing
  // tags that the ONE invalidation path never visits would read as wired and silently not be.
  // Today the invalidation story is the prompt version (a bump reaches a different store) and
  // `ttl`.
}

/** Per-call ceilings, checked before the provider is reached. Never truncates — refuses. */
export interface LlmBudget {
  /** Prompt tokens. */
  readonly tokensIn?: number;
  /** Worst-case price of one call, integer minor units. */
  readonly costPerCall?: Money;
}

export interface LlmVarsArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface LlmDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
> {
  /**
   * Overrides the prompt artifact's own model. The prompt's is part of its content hash and
   * travels with it; this one is the deployment decision, so it wins.
   */
  readonly model?: ModelId;
  readonly input: TInput;
  readonly output: TOutput;
  readonly prompt: Prompt<V>;
  /**
   * Everything the prompt is allowed to see, derived from the parsed input. Required, and
   * async, because the input is usually an id and the prompt needs the row behind it — this
   * is the one declared place a model call loads data, so a reader can see what was sent.
   */
  vars(args: LlmVarsArgs<TInput>): V | Promise<V>;
  readonly cache?: LlmCache<InferOutput<TInput>>;
  readonly budget?: LlmBudget;
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
  /** Enforced completion ceiling. The model never sees it, so it can be cut off mid-answer. */
  readonly maxTokens?: number;
}

export function llm<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: LlmDef<TInput, TOutput, V>): Action<TInput, TOutput> {
  const respond = respondToolFor(def.output);
  return action<TInput, TOutput>({
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    handle: (args) => generate(def, respond, args),
  });
}

async function generate<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: LlmDef<TInput, TOutput, V>,
  respond: LlmTool,
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<InferOutput<TOutput>> {
  const { prompt } = def;
  // The prompt ref is the identity every failure here is about, and unlike the action's
  // export name it exists before registration and can never twin.
  const name = prompt.ref;
  const model = def.model ?? prompt.model ?? DEFAULT_MODEL;
  const rendered = prompt.render(await def.vars({ input: args.input, ctx: args.ctx }));

  return withSpan('ai.llm', async (span) => {
    span.setAttributes({
      'llm.model': model,
      'llm.prompt': prompt.ref,
      'llm.prompt.hash': prompt.hash,
    });

    // A cached answer is still data of unknown provenance, so it goes through the schema like
    // any other. One that no longer fits — the schema moved under it — is a miss, not a
    // failure: the model can produce a fresh answer, and refusing would be worse than paying.
    const cache = await openCache(def, args.input, rendered);
    const hit = await accept(def.output, await cache?.lookup());
    span.setAttribute('llm.cache.hit', hit !== undefined);
    if (hit !== undefined) return hit.value;

    const request: GenerateRequest = {
      model,
      ...(prompt.system === undefined ? {} : { system: prompt.system }),
      messages: [{ role: 'user', content: rendered }],
      maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
      ...(prompt.thinking === undefined ? {} : { thinking: prompt.thinking }),
      tools: [respond],
    };

    // A ledger derived from the ambient one, so a per-call budget can only TIGHTEN the actor
    // and org ceilings this call runs inside, never widen them. The gateway reserves against
    // it before the provider is touched — that is where `X_AI_BUDGET_EXCEEDED` comes from.
    const ledger = (currentBudget() ?? new BudgetLedger({ limits: {} })).derive(
      limitsOf(def.budget),
    );
    const gateway = aiGateway(name);

    return withBudget(ledger, async () => {
      let messages: readonly AiMessage[] = request.messages;
      let issues = 'no output';
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        const result = await gateway.generate({ ...request, messages });
        span.setAttributes({
          'llm.attempts': attempt,
          'llm.stop': result.stopReason,
          'llm.tokens': result.usage.inputTokens + result.usage.outputTokens,
          'llm.cost.minor': result.cost.minor,
        });
        // Branch on the stop reason BEFORE reading the answer. A refusal carries empty or partial
        // content, so parsing it first reports a schema disagreement — a cause that is wrong, a
        // fix that does not apply, and a repair turn spent buying the same refusal again.
        if (result.stopReason === 'refusal') {
          throw new LlmRefusedError({
            prompt: name,
            model: result.model,
            category: result.stopDetails?.category,
            explanation: result.stopDetails?.explanation,
          });
        }
        const parsed = await validateAsync(def.output, structuredOutputOf(result));
        if (parsed.issues === undefined) {
          await cache?.remember(parsed.value);
          return parsed.value;
        }
        // A cut-off answer that also fails its schema is not a disagreement about the shape: the
        // ceiling is the same on the next attempt, so the repair turn is a second truncation.
        if (result.stopReason === 'max_tokens') {
          throw new LlmTruncatedError({ prompt: name, maxTokens: request.maxTokens });
        }
        issues = formatIssues(parsed.issues).join('; ');
        messages = [...messages, { role: 'assistant', content: result.text }, repair(issues)];
      }
      throw new LlmOutputInvalidError({ prompt: name, attempts: ATTEMPTS, issues });
    });
  });
}

/** `undefined` for "does not fit". Wrapped so a legitimately falsy value is still a hit. */
async function accept<TOutput extends StandardSchemaV1>(
  schema: TOutput,
  value: unknown,
): Promise<{ readonly value: InferOutput<TOutput> } | undefined> {
  if (value === undefined) return undefined;
  const parsed = await validateAsync(schema, value);
  return parsed.issues === undefined ? { value: parsed.value } : undefined;
}

function repair(issues: string): AiMessage {
  return {
    role: 'user',
    content: `That answer failed its schema: ${issues}. Call the "${RESPOND}" tool with a value that satisfies it. Answer only through the tool.`,
  };
}

function limitsOf(budget: LlmBudget | undefined): BudgetLimits {
  return {
    ...(budget?.tokensIn === undefined ? {} : { tokensIn: budget.tokensIn }),
    ...(budget?.costPerCall === undefined ? {} : { costPerCall: budget.costPerCall }),
  };
}

/**
 * The output schema as the only tool the model may answer through — the spec's "structured
 * output drives tool use". `toMcpInputSchema` is the same projection an MCP client sees, so
 * a model and an agent are shown one shape, and a schema it cannot express throws HERE, at
 * declaration time, rather than degrading into a permissive node the model cannot satisfy.
 */
function respondToolFor(output: StandardSchemaV1): LlmTool {
  return {
    name: RESPOND,
    description: 'Return the result. Call this exactly once; do not answer in prose.',
    input_schema: toMcpInputSchema(output),
    strict: true,
  };
}

/**
 * The tool call if the model made one, otherwise the text parsed as JSON — a model that
 * answers in prose is a schema failure, not a crash, so it flows into the repair turn.
 */
function structuredOutputOf(result: GenerateResult): unknown {
  const call = result.toolCalls.find((c) => c.name === RESPOND);
  if (call !== undefined) return call.input;
  return parseJsonish(result.text);
}

function parseJsonish(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

interface PromptCache {
  lookup(): Promise<unknown>;
  remember(value: unknown): Promise<void>;
}

/**
 * The semantic cache for one declaration, or `undefined` when none was declared. The instance
 * is partitioned by prompt VERSION as well as scope, which is what makes "editing a prompt
 * requires a version bump" invalidate the cache: a bumped version reaches a different store,
 * so an old answer cannot survive a prompt edit no matter how similar the text.
 */
async function openCache<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: LlmDef<TInput, TOutput, V>,
  input: InferOutput<TInput>,
  rendered: string,
): Promise<PromptCache | undefined> {
  const semantic = def.cache?.semantic;
  if (semantic === undefined) return undefined;
  const scope = semantic.scope?.(input) ?? 'global';
  const store = semanticCacheFor(`${def.prompt.ref}#${def.prompt.hash}::${scope}`);
  const embedding = Array.from(await embedOne(aiEmbedder(), rendered));
  const ttlMs = semantic.ttl === undefined ? undefined : parseDuration(semantic.ttl);
  return {
    async lookup(): Promise<unknown> {
      return (await store.lookup(embedding, semantic.threshold))?.value;
    },
    remember(value: unknown): Promise<void> {
      return store.remember(
        `${def.prompt.hash}:${fnv1a(rendered).toString(16)}`,
        embedding,
        value,
        ttlMs === undefined ? {} : { ttlMs },
      );
    },
  };
}
