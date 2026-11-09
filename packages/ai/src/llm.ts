/**
 * `llm()` — a model call declared as an `action`, NOT a ninth primitive.
 *
 * The eight primitives are the whole vocabulary. A model call is a server-authoritative
 * operation with an input schema, an output schema and a policy, which is the definition of
 * an `action` — so this file is a FACTORY over `action()`, never a new kind of thing. That is
 * why `summarize.openapi()`, `.client()`, `.job()`, `.contract()` and its MCP tool all exist
 * without a line here: the value is an action, so it projects like one, and an app gains an
 * MCP tool backed by a model the moment it declares one.
 *
 * What the factory adds is the model half: the prompt is rendered from the parsed input, the
 * `output` schema is projected into a tool the model must answer through, a per-call budget is
 * reserved before a token is spent, and a near-duplicate prompt hits the semantic cache.
 *
 * `.stream()` is the same action over a different transport, and it is here rather than beside
 * the gateway for one reason: everything that makes `llm()` worth using — policy, input parse,
 * budget scope, semantic cache, span, MCP tool — is lost the moment a feature has to reach past
 * it to `aiGateway()` for tokens on a screen. `./llm-stream.ts` holds the plumbing and states the
 * two decisions a stream forces (no repair turn, budget reserved exactly as before); what a
 * streamed answer must satisfy is decided in this file, next to the non-streaming version of the
 * same rules.
 */

import type { InvokeOptions, StreamAction } from '@ultimat3/action';
import { action, chunksRead } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { finiteCount, SEMCONV, withSpan } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, t, validateAsync } from '@ultimat3/schema';
import { LlmTruncatedError } from './answer-errors';
import type { BudgetLimits } from './budget';
import { budgetKeysFor, currentBudget, screenedMoney, withBudget } from './budget';
import { AiTransportError, LlmOutputInvalidError, LlmRefusedError } from './errors';
import { accept, answerAttributes, observeCall, streamedAnswer } from './llm-answer';
import { openCache } from './llm-cache';
import type { LlmBudget, LlmDef } from './llm-def';
import { llmReport } from './llm-instrument';
import type { LlmStreamChunk } from './llm-stream';
import { currentLlmSink, llmStream, withLlmSink } from './llm-stream';
import { modelForCall } from './model-resolve';
import { moreCapableThan } from './models';
import type { PromptVars } from './prompt';
import { promptCacheHint } from './prompt-cache';
import type { AiMessage, GenerateRequest, GenerateResult } from './provider';
import { isTruncated } from './provider';
import { assertNoSecrets } from './redaction';
import type { Respond } from './respond';
import { RESPOND, respondFor } from './respond';
import { runMeter } from './run-meter';
import { aiGateway, aiRedactor, installedGateway } from './runtime';
import type { Sampling } from './sampling';
import { ignoredSamplingAttribute, screenSampling } from './sampling';

/** Two attempts total: the answer, then one repair turn. See `LlmOutputInvalidError`. */
const ATTEMPTS = 2;

/**
 * Output ceiling when the declaration omits one. Not the model's maximum — a 128k ceiling
 * makes the worst-case cost estimate so large that every `costPerCall` budget refuses.
 */
const DEFAULT_MAX_TOKENS = 4_096;

export type { LlmBudget, LlmCall, LlmDef, LlmVarsArgs } from './llm-def';

/**
 * What `llm()`'s route streams to a caller asking for `text/event-stream`: the answer's text, as it
 * arrives. `thinking` never crosses the wire — reasoning is for the server's own `.stream()`
 * consumer to decide about, not for a browser to render by default. The final frame is `done`,
 * the value that satisfied `output`.
 */
export const LlmTextChunk = t.object({ type: t.literal('text'), text: t.string });

/**
 * An `action` with one extra way to be called. Every projection an action has, it has — its MCP tool,
 * `.openapi()`, `.client()`, `.job()`, `.contract()` — plus a transport for the case an action's
 * single return value cannot serve: text on a screen before the answer is finished.
 */
export interface LlmAction<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>
  extends StreamAction<TInput, TOutput, typeof LlmTextChunk> {
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
  const respond = respondFor(def.output);
  // Screened at DECLARATION, beside `respondFor`'s own refusal and for the same reason: an
  // `llm()` is evaluated at module scope, so a bound that is not one fails the boot rather than
  // the first request. It is the read at `generate` below that makes it urgent — `maxTokens`
  // becomes the pre-flight ESTIMATE, a `NaN` estimate passes every `want > remaining` check, and
  // `debit` then writes that `NaN` onto the ambient ledger AND the per-process `BudgetStore`,
  // where it never expires: one bad declaration turns every actor and org ceiling in the process
  // off for the life of the process. A floor of 1 because a completion ceiling of zero tokens is
  // a call that cannot answer.
  finiteCount('llm', 'maxTokens', def.maxTokens ?? DEFAULT_MAX_TOKENS, 1);
  const sampling = screenSampling('llm', def);
  const built = action<TInput, TOutput, typeof LlmTextChunk>({
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    // Declared, so the route answers `text/event-stream` when asked. Drained (MCP, `.job()`, JSON,
    // a direct call) it is the non-streaming call, repair turn included; only a caller READING the
    // chunks gets the one-attempt streamed turn, exactly as server-side `.stream()` does.
    stream: LlmTextChunk,
    async *handle(args) {
      if (!chunksRead()) return await generate(def, respond, sampling, args);
      const chunks = llmStream<InferOutput<TOutput>>((sink) =>
        withLlmSink(sink, () => generate(def, respond, sampling, args)),
      );
      for await (const chunk of chunks) {
        if (chunk.type === 'text') yield { type: 'text' as const, text: chunk.text };
        else if (chunk.type === 'done') return chunk.value;
      }
      // `llmStream` ends with `done` or throws; reaching here is a sink that closed early.
      throw new AiTransportError({
        provider: 'gateway',
        detail: 'the streamed answer ended without its value',
      });
    },
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
  target: StreamAction<TInput, TOutput, typeof LlmTextChunk>,
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
  respond: Respond,
  sampling: Sampling,
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<InferOutput<TOutput>> {
  const { prompt } = def;
  // The prompt ref is the identity every failure here is about, and unlike the action's
  // export name it exists before registration and can never twin.
  const name = prompt.ref;
  // Screened first: a bad declaration is refused whether or not a gateway exists.
  const limits = limitsOf(def.budget);
  // The declaration, its prompt, then the gateway's `defaultModel` — the app's three places.
  const model = modelForCall('llm', name, def.model, prompt.model);
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
  const promptCache = promptCacheHint(def.promptCache, 'off', args);

  return withSpan(
    'ai.llm',
    async (span) => {
      // OpenTelemetry's gen_ai names for what semconv covers (v31); the framework's own facts are
      // `ultimate.llm.*`. The provider, response model and token usage land when the call settles.
      span.setAttributes({
        [SEMCONV.genAiOperationName]: 'chat',
        [SEMCONV.genAiRequestModel]: model,
        'ultimate.llm.prompt': prompt.ref,
        'ultimate.llm.prompt.hash': prompt.hash,
        // Whether the installed redactor changed anything. Recorded because "we redact" is a claim
        // an audit asks evidence for, and a redactor that silently stopped matching looks identical
        // to one that had nothing to remove until this attribute separates them.
        'ultimate.llm.redacted': redacted,
      });
      // Read when the call ends, not here: the gateway may be what registers the model's row.
      const reportSampling = (): void => {
        span.setAttributes(
          ignoredSamplingAttribute(model, sampling, () =>
            installedGateway()?.samplingWires?.(model),
          ),
        );
      };

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
      span.setAttribute('ultimate.llm.cache.hit', hit !== undefined);
      // Every provider call below goes through this meter, so the report sees who answered.
      const report = llmReport(span, model, runMeter());
      const meter = report.meter;
      if (hit !== undefined) {
        reportSampling();
        report.settle({ cacheHit: true });
        return hit.value;
      }

      // No `tools` yet: the `respond` projection belongs to the non-streaming path alone. A tool
      // call is emitted whole, so forcing the answer through one leaves a stream with nothing to
      // deliver until it is already over.
      const base: GenerateRequest = {
        model,
        ...(system === undefined ? {} : { system }),
        ...(promptCache === undefined ? {} : { promptCache }),
        messages: [{ role: 'user', content: rendered }],
        maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
        ...(prompt.thinking === undefined ? {} : { thinking: prompt.thinking }),
        ...sampling,
        // The caller's own signal, forwarded to the transport exactly as `agent()` does — and
        // inherited by `streamedAnswer` from this same `base`. Without it a disconnected caller left
        // the provider call in flight, billed and unread, and the repair turn bought a SECOND one.
        signal: args.ctx.signal,
      };
      const request: GenerateRequest = { ...base, tools: [respond.tool] };

      // A ledger derived from the ambient one, so a per-call budget can only TIGHTEN the actor
      // and org ceilings this call runs inside, never widen them. The gateway reserves against
      // it before the provider is touched — that is where `X_AI_BUDGET_EXCEEDED` comes from.
      // Rooted in the GATEWAY's own ceilings when no scope is open — an empty root ignored them.
      const gateway = aiGateway(name);
      // Keyed on the CALLER, so the gateway's `actor` / `org` ceilings count this call against them.
      const ledger = (currentBudget() ?? gateway.callLedger(budgetKeysFor(args.ctx.actor))).derive(
        limits,
      );
      const sink = currentLlmSink();

      // Every provider call goes through the meter, so a failure AFTER one answered — a refusal, a
      // truncation, a schema no repair satisfied — is thrown carrying what it was billed.
      const answer = async (): Promise<InferOutput<TOutput>> => {
        if (sink !== undefined) {
          const value = await streamedAnswer(def, name, gateway, base, sink, span, meter);
          await cache?.remember(value);
          return value;
        }
        let messages: readonly AiMessage[] = request.messages;
        let issues = 'no output';
        let rejected: readonly string[] | undefined;
        for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
          const result = await meter.call(gateway.generate({ ...request, messages }));
          span.setAttributes({ 'ultimate.llm.attempts': attempt, ...answerAttributes(result) });
          await observeCall(def, meter, result, attempt, rejected);
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
              alternative: moreCapableThan(result.model, request),
              category: result.stopDetails?.category,
              explanation: result.stopDetails?.explanation,
            });
          }
          // Cut off, so there is no answer to read — and it is read BEFORE the schema for the reason
          // the refusal is: a `respond` call stopped at the ceiling arrives with no arguments, both
          // wires read that as `{}`, and `{}` SATISFIES an `output` whose keys are optional. The
          // ceiling is the same on the next attempt, so the repair turn is a second truncation.
          if (isTruncated(result.stopReason)) {
            throw new LlmTruncatedError({ prompt: name, maxTokens: request.maxTokens });
          }
          const parsed = await validateAsync(def.output, respond.read(result));
          if (parsed.issues === undefined) {
            await cache?.remember(parsed.value);
            return parsed.value;
          }
          rejected = formatIssues(parsed.issues);
          issues = rejected.join('; ');
          const echo = assistantEcho(result);
          messages =
            echo === undefined
              ? [...messages, repair(issues)]
              : [...messages, { role: 'assistant', content: echo }, repair(issues)];
        }
        throw new LlmOutputInvalidError({
          prompt: name,
          attempts: ATTEMPTS,
          issues,
          ...(rejected === undefined ? {} : { list: rejected }),
        });
      };
      return withBudget(ledger, () =>
        answer()
          .then(
            (value) => {
              report.settle({ cacheHit: false });
              return value;
            },
            (error: unknown) => {
              const billed = meter.fail(error);
              report.settle({ cacheHit: false, error: billed });
              throw billed;
            },
          )
          .finally(reportSampling),
      );
    },
    { kind: 'client' },
  );
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
    ...(budget?.costPerCall === undefined
      ? {}
      : { costPerCall: screenedMoney('llm', 'budget.costPerCall', budget.costPerCall) }),
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
