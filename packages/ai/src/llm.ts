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
 *
 * `.stream()` is the same action over a different transport, and it is here rather than beside
 * the gateway for one reason: everything that makes `llm()` worth using — policy, input parse,
 * budget scope, semantic cache, span, `.tool()` — is lost the moment a feature has to reach past
 * it to `aiGateway()` for tokens on a screen. `./llm-stream.ts` holds the plumbing and states the
 * two decisions a stream forces (no repair turn, budget reserved exactly as before); what a
 * streamed answer must satisfy is decided in this file, next to the non-streaming version of the
 * same rules.
 */

import type { Action, ActionMcp, ActionPolicy, InvokeOptions } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Ctx, Span, SpanAttributes } from '@ultimat3/core';
import { finiteCount, withSpan } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, toMcpInputSchema, validateAsync } from '@ultimat3/schema';
import type { BudgetLimits } from './budget';
import { BudgetLedger, currentBudget, withBudget } from './budget';
import {
  LlmOutputInvalidError,
  LlmRefusedError,
  LlmStreamInvalidError,
  LlmTruncatedError,
} from './errors';
import type { Gateway } from './gateway';
import type { LlmCache } from './llm-cache';
import { openCache } from './llm-cache';
import type { LlmSink, LlmStreamChunk } from './llm-stream';
import { currentLlmSink, llmStream, streamOneTurn, withLlmSink } from './llm-stream';
import type { ModelId } from './models';
import { DEFAULT_MODEL, moreCapableThan } from './models';
import type { Prompt, PromptVars } from './prompt';
import type { AiMessage, GenerateRequest, GenerateResult } from './provider';
import { assertNoSecrets } from './redaction';
import { aiGateway, aiRedactor } from './runtime';
import type { LlmTool } from './tools';

/**
 * The tool the model answers through. One name, so the reader never has to guess — and shared
 * with `agent()`, which offers the app's tools alongside it and needs the same name to tell an
 * answer from a tool call.
 */
export const RESPOND = 'respond';

/** Two attempts total: the answer, then one repair turn. See `LlmOutputInvalidError`. */
const ATTEMPTS = 2;

/**
 * Output ceiling when the declaration omits one. Not the model's maximum — a 128k ceiling
 * makes the worst-case cost estimate so large that every `costPerCall` budget refuses.
 */
const DEFAULT_MAX_TOKENS = 4_096;

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

/**
 * An `action` with one extra way to be called. Every projection an action has, it has — `.tool()`,
 * `.openapi()`, `.client()`, `.job()`, `.contract()` — plus a transport for the case an action's
 * single return value cannot serve: text on a screen before the answer is finished.
 */
export interface LlmAction<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>
  extends Action<TInput, TOutput> {
  /**
   * The same call, delivered as it arrives. Runs the action's policy, input parse, budget scope,
   * semantic cache and span exactly as calling it would — the invocation IS an ordinary one,
   * marked so the model half streams. Yields `text` and `thinking` increments, then one `done`
   * carrying the value that satisfied `output`.
   *
   * Lazy: nothing is authorised or sent until the first pull. A streamed call offers the model no
   * `respond` tool — a tool call arrives whole, so forcing one leaves nothing to stream — which
   * means the answer is prose, and its JSON parse is what a non-string `output` validates.
   * Abandoning the iterator stops delivery, never the call: the budget reservation is reconciled
   * by the chain that opened it.
   */
  stream(
    input: InferInput<TInput>,
    opts?: InvokeOptions,
  ): AsyncIterable<LlmStreamChunk<InferOutput<TOutput>>>;
  /** Narrowed: a renamed twin of a model call is still a model call, and still streams. */
  named(name: string): LlmAction<TInput, TOutput>;
}

export function llm<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: LlmDef<TInput, TOutput, V>): LlmAction<TInput, TOutput> {
  const respond = respondToolFor(def.output);
  // Screened at DECLARATION, beside `respondToolFor`'s own refusal and for the same reason: an
  // `llm()` is evaluated at module scope, so a bound that is not one fails the boot rather than
  // the first request. It is the read at `generate` below that makes it urgent — `maxTokens`
  // becomes the pre-flight ESTIMATE, a `NaN` estimate passes every `want > remaining` check, and
  // `debit` then writes that `NaN` onto the ambient ledger AND the per-process `BudgetStore`,
  // where it never expires: one bad declaration turns every actor and org ceiling in the process
  // off for the life of the process. A floor of 1 because a completion ceiling of zero tokens is
  // a call that cannot answer.
  finiteCount('llm', 'maxTokens', def.maxTokens ?? DEFAULT_MAX_TOKENS, 1);
  const built = action<TInput, TOutput>({
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    handle: (args) => generate(def, respond, args),
  });
  return streamable(built);
}

/**
 * Attach `.stream()` to an action IN PLACE, rather than wrapping it. One object is the point:
 * `nameAction` stamps a name onto the very object an app exported, `invoke` reads the declaration
 * off it, and a wrapper would leave a second action the registry never saw.
 *
 * `named()` is re-narrowed for the same reason. `action()`'s `named` builds a fresh twin, which
 * would silently be a model call that cannot stream — so the twin is passed back through here.
 * The original is captured first, or the override would call itself.
 */
function streamable<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
): LlmAction<TInput, TOutput> {
  const rename = target.named.bind(target);
  const self: LlmAction<TInput, TOutput> = Object.assign(target, {
    stream: (
      input: InferInput<TInput>,
      opts?: InvokeOptions,
    ): AsyncIterable<LlmStreamChunk<InferOutput<TOutput>>> =>
      // `self`, not `target`: the invocation has to be of the object that carries the name the
      // audit record, the rate-limit key and the span are filed under.
      llmStream<InferOutput<TOutput>>((sink) => withLlmSink(sink, () => self(input, opts ?? {}))),
    named: (next: string): LlmAction<TInput, TOutput> => streamable(rename(next)),
  });
  return self;
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
  // `vars()` is the one declared place a model call loads data, so it is the one place the
  // framework can refuse a `Secret` and the one place an app's redactor can see the row before it
  // leaves the process. Both run here, between the load and the request, and neither is optional
  // in the sense that matters: the redactor may be absent, the Secret check never is.
  const vars = await def.vars({ input: args.input, ctx: args.ctx });
  assertNoSecrets(name, vars);
  const redact = aiRedactor();
  const rawPrompt = prompt.render(vars);
  const rendered = redact(rawPrompt);
  const system = prompt.system === undefined ? undefined : redact(prompt.system);
  const redacted = rendered !== rawPrompt || system !== prompt.system;

  return withSpan('ai.llm', async (span) => {
    span.setAttributes({
      'llm.model': model,
      'llm.prompt': prompt.ref,
      'llm.prompt.hash': prompt.hash,
      // Whether the installed redactor changed anything. Recorded because "we redact" is a claim
      // an audit asks evidence for, and a redactor that silently stopped matching looks identical
      // to one that had nothing to remove until this attribute separates them.
      'llm.redacted': redacted,
    });

    // A cached answer is still data of unknown provenance, so it goes through the schema like
    // any other. One that no longer fits — the schema moved under it — is a miss, not a
    // failure: the model can produce a fresh answer, and refusing would be worse than paying.
    const cache = await openCache({
      cache: def.cache,
      prompt: { ref: prompt.ref, hash: prompt.hash },
      input: args.input,
      ctx: args.ctx,
      rendered,
    });
    const hit = await accept(def.output, await cache?.lookup());
    span.setAttribute('llm.cache.hit', hit !== undefined);
    if (hit !== undefined) return hit.value;

    // No `tools` yet: the `respond` projection belongs to the non-streaming path alone. A tool
    // call is emitted whole, so forcing the answer through one leaves a stream with nothing to
    // deliver until it is already over.
    const base: GenerateRequest = {
      model,
      ...(system === undefined ? {} : { system }),
      messages: [{ role: 'user', content: rendered }],
      maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
      ...(prompt.thinking === undefined ? {} : { thinking: prompt.thinking }),
      // The caller's own signal, forwarded to the transport exactly as `agent()` does — and
      // inherited by `streamedAnswer` from this same `base`. Without it a disconnected caller left
      // the provider call in flight, billed and unread, and the repair turn bought a SECOND one.
      signal: args.ctx.signal,
    };
    const request: GenerateRequest = { ...base, tools: [respond] };

    // A ledger derived from the ambient one, so a per-call budget can only TIGHTEN the actor
    // and org ceilings this call runs inside, never widen them. The gateway reserves against
    // it before the provider is touched — that is where `X_AI_BUDGET_EXCEEDED` comes from.
    const ledger = (currentBudget() ?? new BudgetLedger({ limits: {} })).derive(
      limitsOf(def.budget),
    );
    const gateway = aiGateway(name);
    const sink = currentLlmSink();

    return withBudget(ledger, async () => {
      if (sink !== undefined) {
        const value = await streamedAnswer(def.output, name, gateway, base, sink, span);
        await cache?.remember(value);
        return value;
      }
      let messages: readonly AiMessage[] = request.messages;
      let issues = 'no output';
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        const result = await gateway.generate({ ...request, messages });
        span.setAttributes({ 'llm.attempts': attempt, ...answerAttributes(result) });
        // Branch on the stop reason BEFORE reading the answer. A refusal carries empty or partial
        // content, so parsing it first reports a schema disagreement — a cause that is wrong, a
        // fix that does not apply, and a repair turn spent buying the same refusal again.
        if (result.stopReason === 'refusal') {
          throw new LlmRefusedError({
            prompt: name,
            model: result.model,
            // The fix names a model the caller can paste, and only ever a MORE capable one:
            // "the first id that differs" answered a refusal on the default model with the next
            // entry down the ladder, which is a retry that cannot succeed.
            alternative: moreCapableThan(result.model),
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
        const echo = assistantEcho(result);
        messages =
          echo === undefined
            ? [...messages, repair(issues)]
            : [...messages, { role: 'assistant', content: echo }, repair(issues)];
      }
      throw new LlmOutputInvalidError({ prompt: name, attempts: ATTEMPTS, issues });
    });
  });
}

/**
 * What one answered turn puts on the span. `llm.provider` is the half the LLM-gateway table
 * called "a fallback is recorded in the span, never silent": fallback in this framework is across
 * PROVIDERS serving one model, never across models, and until the gateway stamped the provider
 * that answered, a fallback was exactly as silent as no fallback at all.
 */
export function answerAttributes(result: GenerateResult): SpanAttributes {
  return {
    'llm.stop': result.stopReason,
    'llm.tokens': result.usage.inputTokens + result.usage.outputTokens,
    'llm.cost.minor': result.cost.minor,
    'llm.provider': result.provider ?? 'unknown',
  };
}

/**
 * One streamed turn, from the same declaration and under the same rules — with one difference
 * that is forced rather than chosen: no repair turn. The tokens are already on the consumer's
 * screen, so a second answer would be two answers to one question; a stream gets one attempt and
 * `X_LLM_STREAM_INVALID` names the non-streaming call as the fix.
 *
 * The stop reason is still read BEFORE the answer, for the reason it always was: a refusal
 * carries empty or partial content and parsing it first reports a schema disagreement that is not
 * one. Truncation is the same call it is on the non-streaming path.
 */
async function streamedAnswer<TOutput extends StandardSchemaV1>(
  output: TOutput,
  name: string,
  gateway: Gateway,
  request: GenerateRequest,
  sink: LlmSink,
  span: Span,
): Promise<InferOutput<TOutput>> {
  const result = await streamOneTurn(gateway, request, sink);
  span.setAttributes({ 'llm.attempts': 1, ...answerAttributes(result) });
  if (result.stopReason === 'refusal') {
    throw new LlmRefusedError({
      prompt: name,
      model: result.model,
      alternative: moreCapableThan(result.model),
      category: result.stopDetails?.category,
      explanation: result.stopDetails?.explanation,
    });
  }
  if (result.stopReason === 'max_tokens') {
    throw new LlmTruncatedError({ prompt: name, maxTokens: request.maxTokens });
  }
  // Prose, and its JSON parse when it has one. Both, because a stream carries no `respond` tool
  // to tell them apart: `output: t.string` is satisfied by the text itself, and an object schema
  // by what the text parses to — trying only one of the two makes a legal declaration unusable.
  const parsed = await accept(output, parseJsonish(result.text));
  if (parsed !== undefined) return parsed.value;
  const fallback = await validateAsync(output, result.text);
  if (fallback.issues === undefined) return fallback.value;
  throw new LlmStreamInvalidError({
    prompt: name,
    issues: formatIssues(fallback.issues).join('; '),
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
    // Screened under the name the DECLARATION uses. `BudgetLedger` screens its own `limits` too,
    // but its field is called `tokensIn` there by coincidence and `request` for `tokensPerRun` —
    // a fix line has to name the key the app actually wrote.
    ...(budget?.tokensIn === undefined
      ? {}
      : { tokensIn: finiteCount('llm', 'budget.tokensIn', budget.tokensIn) }),
    ...(budget?.costPerCall === undefined ? {} : { costPerCall: budget.costPerCall }),
  };
}

/**
 * The output schema as the only tool the model may answer through — the spec's "structured
 * output drives tool use". `toMcpInputSchema` is the same projection an MCP client sees, so
 * a model and an agent are shown one shape, and a schema it cannot express throws HERE, at
 * declaration time, rather than degrading into a permissive node the model cannot satisfy.
 */
export function respondToolFor(output: StandardSchemaV1): LlmTool {
  return {
    name: RESPOND,
    description: 'Return the result. Call this exactly once; do not answer in prose.',
    input_schema: toMcpInputSchema(output),
    strict: true,
  };
}

/**
 * What the model answered, as text the Messages API will accept — or nothing.
 *
 * `result.text` is the EMPTY STRING whenever the answer came through the `respond` tool, which
 * is the dominant path: an empty text block is a 400 (`text content blocks must be non-empty`),
 * so the repair turn came back as `X_AI_PROVIDER_UNAVAILABLE` and the caller never saw the
 * `X_LLM_OUTPUT_INVALID` this loop exists to raise. The tool call's own arguments ARE the answer
 * in that case, and replaying them is what gives the repair turn its context — `AiMessage`
 * carries a string, so the `tool_use` block cannot survive the round trip as itself, and
 * replaying it as text avoids the `tool_result` the API would then demand of the next message.
 */
function assistantEcho(result: GenerateResult): string | undefined {
  if (result.text !== '') return result.text;
  const call = result.toolCalls.find((c) => c.name === RESPOND) ?? result.toolCalls[0];
  if (call === undefined) return undefined;
  const replayed = JSON.stringify(call.input);
  return replayed === undefined || replayed === '' ? undefined : replayed;
}

/**
 * The tool call if the model made one, otherwise the text parsed as JSON — a model that
 * answers in prose is a schema failure, not a crash, so it flows into the repair turn.
 */
export function structuredOutputOf(result: GenerateResult): unknown {
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
