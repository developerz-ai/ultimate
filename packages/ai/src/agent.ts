/**
 * `agent()` — a multi-turn tool-using model call, declared as an `action`.
 *
 * One more instance of the framework's rule — the whole list is `PRIMITIVE_FACTORIES` in
 * `@ultimat3/core`: a new capability arrives as a FACTORY over an existing primitive, never as a
 * ninth kind, and the list is what a reader counts instead of a sentence in one of them that
 * cannot see the rest. A tool-using run is
 * still one server-authoritative operation with an input schema, an output schema and a policy —
 * so this returns an `action`, and inherits `.openapi()`, `.client()`, `.job()`, `.contract()`,
 * its MCP tool (`@ultimat3/mcp`'s `toolFrom`) and its manifest row without a line here.
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

import type { Action } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Ctx, Span } from '@ultimat3/core';
import { finiteCount, isMcpExposed, throwIfAborted, withSpan } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import type { AgentDef, AgentTurn } from './agent-def';
import type { AgentFact } from './agent-facts';
import { registerAgentFact } from './agent-facts';
import { DEFAULT_MAX_REPEATED_TOOL_CALLS, runDeadline, toolLoopGuard } from './agent-guards';
import { sameSystem, systemOf } from './agent-system';
import { assistantTurn, repairTurn, toolResultTurn } from './agent-transcript';
import type { AgentRunUsage } from './agent-usage';
import { addUsage } from './agent-usage';
import type { BudgetLimits } from './budget';
import { budgetKeysFor, currentBudget, screenedMoney, withBudget } from './budget';
import {
  AgentMaxTurnsError,
  AgentToolUnexposedError,
  AiRequestInvalidError,
  LlmOutputInvalidError,
  LlmRefusedError,
  LlmTruncatedError,
} from './errors';
import { answerAttributes } from './llm';
import { describedModel, type ModelSource, modelForCall } from './model-resolve';
import { moreCapableThan } from './models';
import type { PromptVars } from './prompt';
import { promptCacheHint } from './prompt-cache';
import type { AiMessage, GenerateRequest, GenerateResult } from './provider';
import { isTruncated } from './provider';
import { assertNoSecrets } from './redaction';
import type { Respond } from './respond';
import { RESPOND, respondFor } from './respond';
import { aiGateway, aiRedactor, installedGateway } from './runtime';
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

/** Named in every bound refusal, so the fix names the key the declaration carries. */
const SUBJECT = 'agent';

export type { AgentBudget, AgentDef, AgentTurn, AgentVarsArgs } from './agent-def';

export function agent<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): Action<TInput, TOutput> {
  const respond = respondFor(def.output);
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
  // The three loop bounds, screened at DECLARATION for the same reason the tool check above is:
  // the values are here, and an `agent()` runs at module scope, so a bound that is not one fails
  // the boot instead of the ninetieth second of a run. None of them is checked by what it lands
  // on — `turn <= NaN` is false on the FIRST comparison, so the loop takes zero turns and reports
  // `X_AGENT_MAX_TURNS` about a model that was never called; `slice(0, NaN)` is `''`, so every
  // tool result reaches the model empty while the run keeps paying for turns; and `maxTokens`
  // becomes the pre-flight estimate, where a `NaN` disables the ledger for the whole process.
  finiteCount(SUBJECT, 'maxTurns', def.maxTurns ?? DEFAULT_MAX_TURNS, 1);
  finiteCount(
    SUBJECT,
    'maxToolResultChars',
    def.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS,
    1,
  );
  finiteCount(SUBJECT, 'maxTokens', def.maxTokens ?? DEFAULT_MAX_TOKENS, 1);
  const repeats = finiteCount(
    SUBJECT,
    'maxRepeatedToolCalls',
    def.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS,
    1,
  );
  if (repeats < 2) {
    // One "repeat" is the first tool turn of every run: the agent could never use a tool.
    throw new AiRequestInvalidError({
      detail: `agent maxRepeatedToolCalls is ${repeats}, which would stop every run at its first tool turn`,
      fix: 'maxRepeatedToolCalls: 3   # on the agent — at least 2; it counts consecutive identical turns, the first included',
    });
  }
  // `AbortSignal.timeout(NaN)` throws a RangeError mid-run; `0` aborts before turn one.
  if (def.deadlineMs !== undefined) finiteCount(SUBJECT, 'deadlineMs', def.deadlineMs, 1);
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

// `null`, not `undefined`, for a row naming no model yet: the row is a published fact, and an
// absent key reads as a reader that forgot to ask.
const modelFact = (described: {
  readonly model: string | undefined;
  readonly from: ModelSource | undefined;
}): Pick<AgentFact, 'model' | 'modelFrom'> => ({
  model: described.model ?? null,
  modelFrom: described.from ?? null,
});

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
    // The run's own precedence, so the row names the model a call would use NOW: read when the
    // facts are, at describe time, like every name in the row. `modelFrom` says which place
    // answered — `gateway` (or `null`, none yet) depends on the gateway installed at that moment.
    ...modelFact(describedModel(def.model, def.prompt.model, installedGateway()?.defaultModel)),
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
  respond: Respond,
  adapted: Adapted,
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<InferOutput<TOutput>> {
  const { prompt } = def;
  const name = prompt.ref;
  // Screened first: a bad declaration is refused whether or not a gateway exists.
  const limits = limitsOf(def);
  // The declaration, its prompt, then the gateway's `defaultModel` — the app's three places.
  const model = modelForCall('agent', name, def.model, prompt.model);
  // Armed before anything is loaded: `vars()` is part of the run a deadline bounds.
  const deadline = runDeadline(name, def.deadlineMs, args.ctx.signal);
  const vars = await deadline.guard(Promise.resolve(def.vars(args)));
  assertNoSecrets(name, vars);
  const redact = aiRedactor();
  const rawPrompt = prompt.render(vars);
  const rendered = redact(rawPrompt);
  const extra =
    def.system === undefined ? {} : await deadline.guard(Promise.resolve(def.system(args)));
  const rawSystem = systemOf(prompt.system, extra, (text) => text);
  const system = systemOf(prompt.system, extra, redact);
  const promptCache = promptCacheHint(def.promptCache, 'auto', args);
  const repeated = toolLoopGuard(name, def.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS);
  const maxTurns = def.maxTurns ?? DEFAULT_MAX_TURNS;
  const chars = def.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;

  return withSpan('ai.agent', async (span) => {
    span.setAttributes({
      'agent.model': model,
      'agent.prompt': name,
      'agent.prompt.hash': prompt.hash,
      'agent.tools': adapted.offered.length,
      'agent.max_turns': maxTurns,
      'llm.redacted': rendered !== rawPrompt || !sameSystem(system, rawSystem),
      'llm.prompt_cache': promptCache !== undefined,
    });

    // Rooted in the GATEWAY's own ceilings when no scope is open — an empty root ignored them.
    const gateway = aiGateway(name);
    // Keyed on the CALLER, so the gateway's `actor` / `org` ceilings count this call against them.
    const ledger = (currentBudget() ?? gateway.callLedger(budgetKeysFor(args.ctx.actor))).derive(
      limits,
    );
    const base: GenerateRequest = {
      model,
      ...(system === undefined ? {} : { system }),
      ...(promptCache === undefined ? {} : { promptCache }),
      messages: [],
      maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
      ...(prompt.thinking === undefined ? {} : { thinking: prompt.thinking }),
      tools: [...adapted.offered, respond.tool],
      // The caller's own signal, forwarded to the transport. A disconnect has to reach the socket,
      // not just the top of the next turn: a provider call already in flight is the expensive one.
      // The run's deadline is folded into the same signal, so it reaches the socket too.
      signal: deadline.signal,
    };

    return withBudget(ledger, async () => {
      // The actor is read ONCE, from the context the request established, and is the only
      // identity any tool runs as. Nothing below reads an actor out of `result` — a model cannot
      // name the identity it acts as, and a loop that let it would be an escalation primitive.
      const { actor } = args.ctx;
      let messages: readonly AiMessage[] = [{ role: 'user', content: rendered }];
      let calls = 0;
      let issues: string | undefined;
      let total: AgentRunUsage | undefined;

      for (let turn = 1; turn <= maxTurns; turn += 1) {
        // The caller is gone, so unwind instead of finishing. Every turn re-sends the WHOLE
        // transcript, so a loop that keeps going after a disconnect spends the rest of the run's
        // budget, runs every remaining tool's side effects, and discards the answer.
        throwIfAborted(args.ctx);
        deadline.check();
        const result = await deadline
          .guard(gateway.generate({ ...base, messages }))
          .catch((error: unknown) => {
            // The caller left mid-call: the aborted socket reads as a provider failure, which is
            // RETRYABLE. Say what happened instead.
            throwIfAborted(args.ctx);
            throw error;
          });
        total = addUsage(total, result);
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
          run: total,
        });
        assertAnswerable(result, name, base);

        if (requested.length > 0) {
          // Concurrent, and deliberately unbounded WITHIN one turn: the batch is what a single
          // model turn asked for, each entry is an ordinary `action` carrying its own policy and
          // its own `rateLimit`, and a second ceiling here would be a throttle competing with
          // those. A tool that calls a model still reserves on the same ledger chain, which
          // debits before it checks, so the budget holds. Serial cost 5x wall clock for a turn that asked for 5 tools, and nothing
          // in the types or the docs ever said so.
          //
          // Order is by INDEX, not by completion: `Promise.all` resolves positionally and each
          // result carries the `tool_use` id `runLlmToolCall` was handed, so a fast tool answering
          // first cannot be paired with a slow tool's call.
          throwIfAborted(args.ctx);
          deadline.check();
          const results: readonly LlmToolResult[] = await deadline.guard(
            Promise.all(requested.map((call) => runLlmToolCall(adapted.tools, call, actor))),
          );
          calls += requested.length;
          // Before the next turn is bought: the same calls with the same results cannot lead
          // anywhere a further turn would not also lead.
          repeated(requested, results);
          messages = [
            ...messages,
            assistantTurn(result),
            // Parallel tool use — one turn asking for a tool AND answering — is normal, and the
            // answer is speculative: it was written before the result it asked for existed. So
            // the loop continues, and the answer is REJECTED on the wire rather than dropped,
            // because a replayed `respond` block with no `tool_result` is a 400 and the whole run
            // becomes an `X_AI_PROVIDER_UNAVAILABLE`.
            toolResultTurn(results, chars, answers, redact),
          ];
          continue;
        }

        const parsed = await validateAsync(def.output, respond.read(result));
        if (parsed.issues === undefined) return parsed.value;
        // A wrong shape gets another turn like any other, because unlike `llm()` this loop has
        // turns left by construction — and unlike a tool result, the correction is the message.
        issues = formatIssues(parsed.issues).join('; ');
        if (isTruncated(result.stopReason)) {
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
    // What the provider's prompt cache did for this turn — the two numbers that say whether the
    // stable prefix is really stable.
    'llm.cache.read_tokens': event.usage.cacheReadTokens,
    'llm.cache.write_tokens': event.usage.cacheWriteTokens,
  });
  await def.onTurn?.(event);
}

/** Refuse before the answer is read, for the reason `llm()` does: a refusal is a 200 with no answer. */
function assertAnswerable(result: GenerateResult, name: string, request: GenerateRequest): void {
  if (result.stopReason !== 'refusal') return;
  throw new LlmRefusedError({
    prompt: name,
    model: result.model,
    alternative: moreCapableThan(result.model, request),
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
    // Screened under the names the DECLARATION uses, not the ledger's: `tokensPerRun` arrives at
    // `BudgetLimits` as `request`, and a fix line naming a key the app never wrote is not a fix.
    ...(budget?.tokensIn === undefined
      ? {}
      : { tokensIn: finiteCount(SUBJECT, 'budget.tokensIn', budget.tokensIn) }),
    ...(budget?.costPerCall === undefined
      ? {}
      : { costPerCall: screenedMoney(SUBJECT, 'budget.costPerCall', budget.costPerCall) }),
    // The ledger's `request` scope accumulates across every call made under one ledger, which for
    // a run under `withBudget` is exactly "the whole run".
    ...(budget?.tokensPerRun === undefined
      ? {}
      : { request: finiteCount(SUBJECT, 'budget.tokensPerRun', budget.tokensPerRun) }),
  };
}
