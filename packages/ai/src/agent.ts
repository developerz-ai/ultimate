/**
 * `agent()` — a multi-turn tool-using model call, declared as an `action`.
 *
 * One more instance of the framework's rule — the whole list is `PRIMITIVE_FACTORIES` in
 * `@ultimat3/core`: a new capability arrives as a FACTORY over an existing primitive, never as a
 * ninth kind, and the list is what a reader counts instead of a sentence in one of them that
 * cannot see the rest. A tool-using run is
 * still one server-authoritative operation with an input schema, an output schema and a policy —
 * so this returns an `action`, and inherits `.tool()`, `.openapi()`, `.client()`, `.job()`,
 * `.contract()` and its manifest row without a line here.
 *
 * It exists because the alternative is a hand-rolled loop outside the framework, and a hand-rolled
 * loop is where the dangerous mistake lives: taking the ACTOR from the model's output. Here the
 * actor is `ctx.actor` and nothing the model emits can reach it — `runLlmToolCall` is handed an
 * identity the request established, and the tool it runs is an ordinary action whose own policy
 * decides. There is no "LLM permissions" concept, because there is no second authz system.
 *
 * Deliberately NOT here: a semantic cache. Similar prompts do not have similar answers once the
 * answer depends on what `lookupOrder` returned this second, and a cache over that would serve
 * one run's world state to another. Version bump plus the tools' own caching is the story.
 */

import type { Action, ActionMcp, ActionPolicy } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Ctx, Span } from '@ultimat3/core';
import { isMcpExposed, throwIfAborted, withSpan } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import type { AgentFact } from './agent-facts';
import { registerAgentFact } from './agent-facts';
import { assistantTurn, repairTurn, toolResultTurn } from './agent-transcript';
import type { BudgetLimits } from './budget';
import { BudgetLedger, currentBudget, withBudget } from './budget';
import {
  AgentMaxTurnsError,
  AgentToolUnexposedError,
  LlmOutputInvalidError,
  LlmRefusedError,
  LlmTruncatedError,
} from './errors';
import type { LlmBudget } from './llm';
import { answerAttributes, RESPOND, respondToolFor, structuredOutputOf } from './llm';
import type { ModelId } from './models';
import { DEFAULT_MODEL, moreCapableThan } from './models';
import type { Prompt, PromptVars } from './prompt';
import type {
  AiMessage,
  GenerateRequest,
  GenerateResult,
  StopReason,
  TokenUsage,
} from './provider';
import { assertNoSecrets } from './redaction';
import { aiGateway, aiRedactor } from './runtime';
import type { AgentTool, LlmTool, LlmToolResult, ProjectableAction } from './tools';
import { asProjectableAction, runLlmToolCall, toLlmTools, toolLabel } from './tools';

/**
 * Turn ceiling when the declaration omits one. Low on purpose: a loop that needs more than this
 * is usually a loop with no exit condition, and every turn re-sends the whole transcript, so cost
 * grows quadratically in turns rather than linearly.
 */
const DEFAULT_MAX_TURNS = 8;

/** Output ceiling per turn when the declaration omits one. Same reasoning as `llm()`'s. */
const DEFAULT_MAX_TOKENS = 4_096;

/**
 * Characters of ONE tool result the model may read. A tool that returns a 2MB row set otherwise
 * spends the whole context window on turn two and every later turn re-sends it — the transcript
 * is the request, so an untruncated result is billed once per remaining turn.
 */
const DEFAULT_TOOL_RESULT_CHARS = 4_000;

export interface AgentBudget extends LlmBudget {
  /**
   * Token ceiling for the WHOLE run, every turn counted. The one ceiling `llm()` does not need:
   * a single call is bounded by `maxTokens`, a loop is bounded by nothing until this is set.
   */
  readonly tokensPerRun?: number;
}

export interface AgentVarsArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface AgentDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
> {
  readonly model?: ModelId;
  readonly input: TInput;
  readonly output: TOutput;
  readonly prompt: Prompt<V>;
  /** Same contract as `llm()`: the one declared place a run loads data. */
  vars(args: AgentVarsArgs<TInput>): V | Promise<V>;
  /**
   * The actions the model may call. Each must be `mcp: { expose: true }` — the same predicate an
   * external MCP client is filtered by, so an in-app agent and an external one are offered
   * exactly the same tools. Listing one that is not exposed is refused at declaration rather than
   * dropped, because a tool that reads as offered and silently is not is the worst of both.
   */
  readonly tools: readonly AgentTool[];
  /** Hard ceiling on model turns. Reaching it is `X_AGENT_MAX_TURNS`, never a partial answer. */
  readonly maxTurns?: number;
  readonly maxToolResultChars?: number;
  readonly budget?: AgentBudget;
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
  /** Enforced completion ceiling PER TURN. The model never sees it. */
  readonly maxTokens?: number;
  /**
   * Called once per completed model turn, before the answer or the tool calls are acted on. The
   * one thing a multi-turn run could not do until 2026-08: a 90-second loop emitted nothing until
   * it returned, so a progress indicator, a per-turn spend line and a transcript log all had to be
   * hand-rolled outside the framework — which is exactly the loop `agent()` exists to replace.
   *
   * Observation only: it cannot steer the loop, cannot see the transcript and cannot reach the
   * actor. A throw from it FAILS the run rather than being swallowed — it is the app's code on the
   * run's own path, and an observer that silently stopped working would be indistinguishable from
   * one that is fine. The same facts land on the span as an `agent.turn` event, so a run that
   * declares no hook is still readable in a trace.
   *
   * NOT `.stream()`. Tokens on a screen is a different contract, and `llm()`'s streamed half is
   * one turn deep by construction; this is per TURN.
   */
  onTurn?(event: AgentTurn): void | Promise<void>;
}

/** One completed model turn, as an observer sees it. Facts only — no transcript, no actor. */
export interface AgentTurn {
  /** 1-based, so `turn === maxTurns` is the last one this run will take. */
  readonly turn: number;
  readonly maxTurns: number;
  readonly model: ModelId;
  /** Tools this turn asked for, in the order the model emitted them. `respond` is not one. */
  readonly toolCalls: readonly string[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  /** This turn's cost alone, integer minor units — never the run's running total. */
  readonly cost: Money;
}

export function agent<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): Action<TInput, TOutput> {
  const respond = respondToolFor(def.output);
  // At declaration, because the tools are values by then and a run that discovers this at the
  // first request has already been declared, registered and projected as if it worked. Asked of
  // the DECLARATION rather than of the projection: `isMcpExposed` needs no name, and a real
  // `action()` beside this one in the same module has none until `registerActions` runs at boot.
  const unexposed = def.tools.filter((tool) => !isMcpExposed(tool.mcp));
  if (unexposed.length > 0) {
    throw new AgentToolUnexposedError({
      agent: def.prompt.ref,
      tools: unexposed.map(toolLabel),
    });
  }
  // Projected on FIRST RUN, memoised, for the reason above: `agent()` is evaluated at module
  // scope and a tool's name is stamped by `registerAction` at boot, so naming it here would make
  // the ordinary `export const publishPost = action(...)` beside it `X_ACTION_UNREGISTERED`.
  let adapted: Adapted | undefined;
  const adapt = (): Adapted => {
    if (adapted === undefined) adapted = project(def.tools);
    return adapted;
  };
  const built = action<TInput, TOutput>({
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    handle: (args) => run(def, respond, adapt(), args),
  });
  // A thunk, resolved when the manifest asks: every name in the row is stamped at boot, and this
  // line runs at module scope.
  registerAgentFact(built, () => factsOf(def));
  return built;
}

function factsOf<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): Omit<AgentFact, 'name'> {
  const budget = def.budget;
  return {
    prompt: def.prompt.ref,
    promptId: def.prompt.id,
    promptHash: def.prompt.hash,
    model: def.model ?? def.prompt.model ?? DEFAULT_MODEL,
    maxTurns: def.maxTurns ?? DEFAULT_MAX_TURNS,
    maxToolResultChars: def.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS,
    tools: [...def.tools.map(toolLabel)].sort(),
    budget: {
      tokensIn: budget?.tokensIn ?? null,
      tokensPerRun: budget?.tokensPerRun ?? null,
      costPerCall: budget?.costPerCall ?? null,
    },
    mcp: isMcpExposed(def.mcp),
  };
}

/** The tools as `runLlmToolCall` consumes them, and as the request offers them. One projection. */
interface Adapted {
  readonly tools: readonly ProjectableAction[];
  readonly offered: readonly LlmTool[];
}

function project(tools: readonly AgentTool[]): Adapted {
  const projected = tools.map(asProjectableAction);
  return { tools: projected, offered: toLlmTools(projected) };
}

async function run<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: AgentDef<TInput, TOutput, V>,
  respond: LlmTool,
  adapted: Adapted,
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<InferOutput<TOutput>> {
  const { prompt } = def;
  const name = prompt.ref;
  const model = def.model ?? prompt.model ?? DEFAULT_MODEL;
  const vars = await def.vars({ input: args.input, ctx: args.ctx });
  assertNoSecrets(name, vars);
  const redact = aiRedactor();
  const rawPrompt = prompt.render(vars);
  const rendered = redact(rawPrompt);
  const system = prompt.system === undefined ? undefined : redact(prompt.system);
  const maxTurns = def.maxTurns ?? DEFAULT_MAX_TURNS;
  const chars = def.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;

  return withSpan('ai.agent', async (span) => {
    span.setAttributes({
      'agent.model': model,
      'agent.prompt': name,
      'agent.prompt.hash': prompt.hash,
      'agent.tools': adapted.offered.length,
      'agent.max_turns': maxTurns,
      'llm.redacted': rendered !== rawPrompt || system !== prompt.system,
    });

    const ledger = (currentBudget() ?? new BudgetLedger({ limits: {} })).derive(limitsOf(def));
    const gateway = aiGateway(name);
    const base: GenerateRequest = {
      model,
      ...(system === undefined ? {} : { system }),
      messages: [],
      maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
      ...(prompt.thinking === undefined ? {} : { thinking: prompt.thinking }),
      tools: [...adapted.offered, respond],
      // The caller's own signal, forwarded to the transport. A disconnect has to reach the socket,
      // not just the top of the next turn: a provider call already in flight is the expensive one.
      signal: args.ctx.signal,
    };

    return withBudget(ledger, async () => {
      // The actor is read ONCE, from the context the request established, and is the only
      // identity any tool runs as. Nothing below reads an actor out of `result` — a model cannot
      // name the identity it acts as, and a loop that let it would be an escalation primitive.
      const { actor } = args.ctx;
      let messages: readonly AiMessage[] = [{ role: 'user', content: rendered }];
      let calls = 0;
      let issues: string | undefined;

      for (let turn = 1; turn <= maxTurns; turn += 1) {
        // The caller is gone, so unwind instead of finishing. Every turn re-sends the WHOLE
        // transcript, so a loop that keeps going after a disconnect spends the rest of the run's
        // budget, runs every remaining tool's side effects, and discards the answer.
        throwIfAborted(args.ctx);
        const result = await gateway.generate({ ...base, messages });
        const requested = result.toolCalls.filter((call) => call.name !== RESPOND);
        // The same turn's `respond` calls, kept rather than forgotten: they are never RUN, but
        // `assistantTurn` replays them, and every replayed `tool_use` has to be answered.
        const answers = result.toolCalls.filter((call) => call.name === RESPOND);
        span.setAttributes({
          'agent.turns': turn,
          'agent.tool_calls': calls,
          ...answerAttributes(result),
        });
        await observeTurn(def, span, {
          turn,
          maxTurns,
          model: result.model,
          toolCalls: requested.map((call) => call.name),
          stopReason: result.stopReason,
          usage: result.usage,
          cost: result.cost,
        });
        assertAnswerable(result, name);

        if (requested.length > 0) {
          // Concurrent, and deliberately unbounded WITHIN one turn: the batch is what a single
          // model turn asked for, each entry is an ordinary `action` carrying its own policy and
          // its own `rateLimit`, and a second ceiling here would be a throttle competing with
          // those. A tool that calls a model still queues on the ledger's root turnstile, so the
          // budget holds. Serial cost 5x wall clock for a turn that asked for 5 tools, and nothing
          // in the types or the docs ever said so.
          //
          // Order is by INDEX, not by completion: `Promise.all` resolves positionally and each
          // result carries the `tool_use` id `runLlmToolCall` was handed, so a fast tool answering
          // first cannot be paired with a slow tool's call.
          throwIfAborted(args.ctx);
          const results: readonly LlmToolResult[] = await Promise.all(
            requested.map((call) => runLlmToolCall(adapted.tools, call, actor)),
          );
          calls += requested.length;
          messages = [
            ...messages,
            assistantTurn(result),
            // Parallel tool use — one turn asking for a tool AND answering — is normal, and the
            // answer is speculative: it was written before the result it asked for existed. So
            // the loop continues, and the answer is REJECTED on the wire rather than dropped,
            // because a replayed `respond` block with no `tool_result` is a 400 and the whole run
            // becomes an `X_AI_PROVIDER_UNAVAILABLE`.
            toolResultTurn(results, chars, answers),
          ];
          continue;
        }

        const parsed = await validateAsync(def.output, structuredOutputOf(result));
        if (parsed.issues === undefined) return parsed.value;
        // A wrong shape gets another turn like any other, because unlike `llm()` this loop has
        // turns left by construction — and unlike a tool result, the correction is the message.
        issues = formatIssues(parsed.issues).join('; ');
        if (result.stopReason === 'max_tokens') {
          throw new LlmTruncatedError({ prompt: name, maxTokens: base.maxTokens });
        }
        messages = [...messages, assistantTurn(result), repairTurn(answers, issues)];
      }

      // Two different exhaustions, so two different causes: a loop that kept calling tools and
      // never answered is not the same event as one that answered the wrong shape every time.
      if (issues !== undefined) {
        throw new LlmOutputInvalidError({ prompt: name, attempts: maxTurns, issues });
      }
      throw new AgentMaxTurnsError({ agent: name, turns: maxTurns, calls });
    });
  });
}

/**
 * One turn, reported twice: onto the span every run already opens, and to the declaration's own
 * hook. The span event is free — nothing to install, and a trace is where a stalled run is
 * actually diagnosed — and the hook is what a progress indicator or a per-turn spend line reads.
 *
 * Awaited, and not guarded: a throw from `onTurn` fails the run. It is the app's code on the run's
 * path, and an observer that quietly stopped working reads exactly like one that is fine.
 */
async function observeTurn<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>, span: Span, event: AgentTurn): Promise<void> {
  span.addEvent('agent.turn', {
    'agent.turn': event.turn,
    'agent.turn.tool_calls': event.toolCalls.length,
    'llm.stop': event.stopReason,
    'llm.cost.minor': event.cost.minor,
  });
  await def.onTurn?.(event);
}

/** Refuse before the answer is read, for the reason `llm()` does: a refusal is a 200 with no answer. */
function assertAnswerable(result: GenerateResult, name: string): void {
  if (result.stopReason !== 'refusal') return;
  throw new LlmRefusedError({
    prompt: name,
    model: result.model,
    alternative: moreCapableThan(result.model),
    category: result.stopDetails?.category,
    explanation: result.stopDetails?.explanation,
  });
}

function limitsOf<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): BudgetLimits {
  const budget = def.budget;
  return {
    ...(budget?.tokensIn === undefined ? {} : { tokensIn: budget.tokensIn }),
    ...(budget?.costPerCall === undefined ? {} : { costPerCall: budget.costPerCall }),
    // The ledger's `request` scope accumulates across every call made under one ledger, which for
    // a run under `withBudget` is exactly "the whole run".
    ...(budget?.tokensPerRun === undefined ? {} : { request: budget.tokensPerRun }),
  };
}
