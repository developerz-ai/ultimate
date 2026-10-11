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
import type { Ctx } from '@ultimat3/core';
import { throwIfAborted, withSpan } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import type { AgentAction } from './agent-continue';
import {
  continuationTurn,
  currentAgentSession,
  screenTranscript,
  sessionCalls,
  TRANSCRIPT_VERSION,
} from './agent-continue';
import type { AgentBounds } from './agent-declared';
import { factsOf, limitsOf, SUBJECT, screenBounds } from './agent-declared';
import type { AgentDef } from './agent-def';
import { AgentTranscriptInvalidError } from './agent-errors';
import { registerAgentFact } from './agent-facts';
import { runDeadline, toolLoopGuard } from './agent-guards';
import { sameSystem, systemOf } from './agent-system';
import { assistantTurn, repairTurn, toolResultTurn } from './agent-transcript';
import { assertAnswerable, observeTurn } from './agent-turn';
import { runTotal } from './agent-usage';
import { LlmTruncatedError } from './answer-errors';
import { budgetKeysFor, currentBudget, withBudget } from './budget';
import { AgentMaxTurnsError, AgentToolUnexposedError, LlmOutputInvalidError } from './errors';
import { answerAttributes } from './llm';
import { modelForCall } from './model-resolve';
import type { PromptVars } from './prompt';
import { promptCacheHint } from './prompt-cache';
import type { AiMessage, GenerateRequest } from './provider';
import { isTruncated } from './provider';
import { assertNoSecrets } from './redaction';
import type { Respond } from './respond';
import { RESPOND, respondFor } from './respond';
import { runMeter } from './run-meter';
import { aiGateway, aiRedactor } from './runtime';
import type { Sampling } from './sampling';
import { ignoredSampling, screenSampling } from './sampling';
import type { AgentTool, LlmTool, LlmToolResult, ProjectableAction } from './tools';
import { asProjectableAction, isOfferedTool, runLlmToolCall, toLlmTools, toolLabel } from './tools';

export type { AgentBudget, AgentDef, AgentTurn, AgentVarsArgs } from './agent-def';

export function agent<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): AgentAction<TInput, TOutput> {
  const respond = respondFor(def.output);
  // At declaration, because the tools are values by then and a run that discovers this at the
  // first request has already been declared, registered and projected as if it worked. Asked of
  // the DECLARATION rather than of the projection: `isMcpExposed` needs no name, and a real
  // `action()` beside this one in the same module has none until `registerActions` runs at boot.
  const unexposed = def.tools.filter((tool) => !isOfferedTool(tool));
  if (unexposed.length > 0) {
    throw new AgentToolUnexposedError({
      agent: def.prompt.ref,
      tools: unexposed.map(toolLabel),
    });
  }
  const bounds = screenBounds(def);
  const sampling = screenSampling(SUBJECT, def);
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
    handle: (args) => run(def, respond, adapt(), { ...bounds, sampling }, args),
  });
  // A thunk, resolved when the manifest asks: every name in the row is stamped at boot, and this
  // line runs at module scope.
  registerAgentFact(built, () => factsOf(def));
  return continuable(built);
}

/**
 * Attach `.run()` and `.continue()` IN PLACE, for the reason `llm()`'s `streamable` gives: the
 * object an app exported is the one the registry names, and `named()`'s twin gets them too.
 */
function continuable<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
): AgentAction<TInput, TOutput> {
  const rename = target.named.bind(target);
  return Object.assign(target, {
    ...sessionCalls(target),
    named: (next: string): AgentAction<TInput, TOutput> => continuable(rename(next)),
  });
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
  bounds: AgentBounds & { readonly sampling: Sampling },
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<InferOutput<TOutput>> {
  const { prompt } = def;
  const name = prompt.ref;
  // A `.continue()` in flight: its handle is the app's stored data, so it is screened before
  // anything is loaded, reserved or sent.
  const session = currentAgentSession();
  const resume = session?.resume;
  const prior = resume === undefined ? undefined : screenTranscript(name, resume.transcript);
  if (resume !== undefined && resume.user.trim() === '') {
    throw new AgentTranscriptInvalidError({ agent: name, reason: 'the user turn is empty' });
  }
  // Screened first: a bad declaration is refused whether or not a gateway exists.
  const limits = limitsOf(def, prior?.usage);
  // The declaration, its prompt, then the gateway's `defaultModel` — the app's three places.
  const model = modelForCall('agent', name, def.model, prompt.model);
  // Armed before anything is loaded: `vars()` is part of the run a deadline bounds.
  const deadline = runDeadline(name, def.deadlineMs, args.ctx.signal);
  const redact = aiRedactor();
  // A continuation does not render the prompt again: the transcript holds what was sent, and
  // `vars()` — the load — is not run a second time. Its own turn is the caller's text.
  let rawPrompt = resume?.user;
  if (rawPrompt === undefined) {
    const vars = await deadline.guard(Promise.resolve(def.vars(args)));
    assertNoSecrets(name, vars);
    rawPrompt = prompt.render(vars);
  }
  const rendered = redact(rawPrompt);
  const extra =
    def.system === undefined ? {} : await deadline.guard(Promise.resolve(def.system(args)));
  const rawSystem = systemOf(prompt.system, extra, (text) => text);
  const system = systemOf(prompt.system, extra, redact);
  const promptCache = promptCacheHint(def.promptCache, 'auto', args);
  const repeated = toolLoopGuard(name, bounds.maxRepeatedToolCalls);
  const { maxTurns, maxToolResultChars: chars } = bounds;

  return withSpan('ai.agent', async (span) => {
    span.setAttributes({
      'agent.model': model,
      'agent.prompt': name,
      'agent.prompt.hash': prompt.hash,
      'agent.tools': adapted.offered.length,
      'agent.max_turns': maxTurns,
      'llm.redacted': rendered !== rawPrompt || !sameSystem(system, rawSystem),
      'llm.prompt_cache': promptCache !== undefined,
      'llm.sampling.ignored': ignoredSampling(model, bounds.sampling).join(','),
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
      maxTokens: bounds.maxTokens,
      ...(prompt.effort === undefined ? {} : { effort: prompt.effort }),
      ...(prompt.thinking === undefined ? {} : { thinking: prompt.thinking }),
      ...bounds.sampling,
      tools: [...adapted.offered, respond.tool],
      // The caller's own signal, forwarded to the transport. A disconnect has to reach the socket,
      // not just the top of the next turn: a provider call already in flight is the expensive one.
      // The run's deadline is folded into the same signal, so it reaches the socket too.
      signal: deadline.signal,
    };

    // Every provider call below goes through the meter, so whatever ends the run — a ceiling, a
    // deadline, a truncated turn, the caller leaving — is thrown carrying what the run was billed.
    const meter = runMeter();
    const loop = async (): Promise<InferOutput<TOutput>> => {
      // The actor is read ONCE, from the context the request established, and is the only
      // identity any tool runs as. Nothing below reads an actor out of `result` — a model cannot
      // name the identity it acts as, and a loop that let it would be an escalation primitive.
      const { actor } = args.ctx;
      let messages: readonly AiMessage[] =
        prior === undefined
          ? [{ role: 'user', content: rendered }]
          : [...prior.messages, continuationTurn(prior, rendered)];
      let calls = 0;
      let issues: string | undefined;
      // The issues of the answer the turn in flight is repairing — `onTurn`'s `repairOf`.
      let rejected: readonly string[] | undefined;

      // `maxTurns` counts the run AND its continuations: a handle that used them all takes none.
      for (let turn = (prior?.turns ?? 0) + 1; turn <= maxTurns; turn += 1) {
        // The caller is gone, so unwind instead of finishing. Every turn re-sends the WHOLE
        // transcript, so a loop that keeps going after a disconnect spends the rest of the run's
        // budget, runs every remaining tool's side effects, and discards the answer.
        throwIfAborted(args.ctx);
        deadline.check();
        const result = await deadline
          .guard(meter.call(gateway.generate({ ...base, messages })))
          .catch((error: unknown) => {
            // The caller left mid-call: the aborted socket reads as a provider failure, which is
            // RETRYABLE. Say what happened instead.
            throwIfAborted(args.ctx);
            throw error;
          });
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
          ...(result.costExact === undefined ? {} : { costExact: result.costExact }),
          ...(rejected === undefined ? {} : { repairOf: rejected }),
          run: runTotal(result.model, prior?.usage, meter.total()),
        });
        assertAnswerable(result, name, base);
        // Before a tool runs and before the answer is read: a turn cut off at the ceiling carries
        // arguments that stop wherever the ceiling fell — `{}` on both wires for a call that never
        // reached its first byte — so running a tool on them is a side effect the model did not
        // ask for, and validating them accepts an empty answer for any `output` of optional keys.
        if (isTruncated(result.stopReason)) {
          throw new LlmTruncatedError({
            prompt: name,
            maxTokens: base.maxTokens,
            subject: SUBJECT,
          });
        }

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
            // Inside the deadline's scope, so each tool's own `ctx.signal` carries it.
            deadline.scope(() =>
              Promise.all(requested.map((call) => runLlmToolCall(adapted.tools, call, actor))),
            ),
          );
          calls += requested.length;
          rejected = undefined;
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
        if (parsed.issues === undefined) {
          // Kept only for `.run()` / `.continue()`: a plain call leaves nothing behind.
          if (session !== undefined) {
            const usage = runTotal(result.model, prior?.usage, meter.total());
            session.finished = {
              transcript: {
                v: TRANSCRIPT_VERSION,
                agent: name,
                messages: [...messages, assistantTurn(result)],
                turns: turn,
                usage: usage.usage,
              },
              turns: turn,
              usage,
            };
          }
          return parsed.value;
        }
        // A wrong shape gets another turn like any other, because unlike `llm()` this loop has
        // turns left by construction — and unlike a tool result, the correction is the message.
        rejected = formatIssues(parsed.issues);
        issues = rejected.join('; ');
        messages = [...messages, assistantTurn(result), repairTurn(answers, issues)];
      }

      // Two different exhaustions, so two different causes: a loop that kept calling tools and
      // never answered is not the same event as one that answered the wrong shape every time.
      if (issues !== undefined) {
        throw new LlmOutputInvalidError({
          prompt: name,
          attempts: maxTurns,
          issues,
          ...(rejected === undefined ? {} : { list: rejected }),
        });
      }
      throw new AgentMaxTurnsError({ agent: name, turns: maxTurns, calls });
    };
    return withBudget(ledger, () =>
      loop().catch((error: unknown) => {
        throw meter.fail(error);
      }),
    );
  });
}
