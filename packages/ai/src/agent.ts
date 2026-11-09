/**
 * `agent()` — a multi-turn tool-using model call, declared as an `action`.
 *
 * A FACTORY over an existing primitive (`PRIMITIVE_FACTORIES` in `@ultimat3/core`), never a ninth
 * kind: a tool-using run is still one server-authoritative operation with an input schema, an
 * output schema and a policy — so this returns an `action`, and inherits `.openapi()`, `.client()`,
 * `.job()`, `.contract()`, its MCP tool (`toolFrom`) and its manifest row without a line here.
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
import { action, noteToolNames } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { finiteCount, throwIfAborted, withSpan } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import { checkpointer } from './agent-checkpoint';
import type { Compactor } from './agent-compact';
import { compactor } from './agent-compact';
import type { CompactPlan } from './agent-compact-def';
import { screenCompact } from './agent-compact-def';
import type { AgentAction, TranscriptBinding } from './agent-continue';
import { continued, screenTranscript, sealTranscript, withTranscript } from './agent-continue';
import { factsOf, limitsOf, SUBJECT, screenBounds } from './agent-declared';
import type { AgentDef } from './agent-def';
import { AgentTranscriptInvalidError } from './agent-errors';
import { registerAgentFact } from './agent-facts';
import { runDeadline, toolLoopGuard } from './agent-guards';
import type { Adapted, PerRun } from './agent-per-run';
import { project, resolvePerRun } from './agent-per-run';
import { assertRunCost } from './agent-run-limits';
import type { TurnSend } from './agent-send';
import { sendTurn } from './agent-send';
import { claimAgentSession, sessionCalls } from './agent-session';
import type { EmitChunk } from './agent-stream';
import { AgentChunk, streamOf } from './agent-stream';
import { sameSystem, systemOf } from './agent-system';
import type { ToolRun } from './agent-tools';
import { DEFAULT_TOOL_CONCURRENCY, toolTurn } from './agent-tools';
import { assistantTurn, repairTurn } from './agent-transcript';
import { assertAnswerable, observeTurn } from './agent-turn';
import { runTotal } from './agent-usage';
import { budgetKeysFor, currentBudget, withBudget } from './budget';
import { AgentMaxTurnsError, AgentToolUnexposedError, LlmOutputInvalidError } from './errors';
import { answerAttributes } from './llm-answer';
import type { PromptVars } from './prompt';
import { promptCacheHint } from './prompt-cache';
import type { AiMessage, GenerateRequest } from './provider';
import { estimateCost } from './provider';
import { assertNoSecrets } from './redaction';
import type { Respond } from './respond';
import { RESPOND, respondFor } from './respond';
import { runMeter } from './run-meter';
import { aiGateway, aiRedactor, installedGateway } from './runtime';
import type { Sampling } from './sampling';
import { ignoredSamplingAttribute, screenSampling } from './sampling';
import { isOfferedTool, toolLabel } from './tools';

export type { AgentCompaction, AgentCompactOption, AgentCompactRule } from './agent-compact-def';
export type {
  AgentBudget,
  AgentDef,
  AgentModel,
  AgentRunLimits,
  AgentTurn,
  AgentVarsArgs,
} from './agent-def';

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
  // An in-process tool is in no registry: the `manifest` step reads this to tell a gate on one from
  // a gate on a typo. An action beside this one may have no name yet, and its registry answers it.
  noteToolNames(def.tools.map((tool) => tool.name).filter((name) => name !== ''));
  const bounds = screenBounds(def);
  // What every run is held under; a run's `limits()` may only lower it (`narrowCeilings`).
  const declared = { bounds, deadlineMs: def.deadlineMs, budget: def.budget };
  // This declaration's identity for `.run()` / `.continue()` sessions (`claimAgentSession`).
  const owner = {};
  const sampling = screenSampling(SUBJECT, def);
  const compact = screenCompact(def.compact, bounds.maxTokens);
  const toolConcurrency = finiteCount(
    SUBJECT,
    'maxToolConcurrency',
    def.maxToolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
    1,
  );
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
    // Streamed: an ordinary call drains it to the answer; `accept: text/event-stream` sees each turn.
    stream: AgentChunk,
    handle: (args) =>
      streamOf(async (emit) =>
        run(
          def,
          respond,
          await resolvePerRun(def, { ...declared, adapted: adapt() }, args),
          { sampling, owner, compact, emit, toolConcurrency },
          args,
        ),
      ),
  });
  // A thunk, resolved when the manifest asks: every name in the row is stamped at boot, and this
  // line runs at module scope.
  registerAgentFact(built, () => factsOf(def));
  return continuable(built, owner);
}

/** `.run()` / `.continue()` IN PLACE (as `llm()`'s `streamable`): the export IS the registry's. */
function continuable<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
  owner: object,
): AgentAction<TInput, TOutput> {
  const rename = target.named.bind(target);
  return Object.assign(target, {
    ...sessionCalls(target, owner),
    named: (next: string): AgentAction<TInput, TOutput> => continuable(rename(next), owner),
  });
}

async function run<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: AgentDef<TInput, TOutput, V>,
  respond: Respond,
  /** This run's picks — model, offered tools, ceilings — resolved from the declaration. */
  picked: PerRun,
  fixed: {
    readonly sampling: Sampling;
    readonly owner: object;
    readonly compact: CompactPlan | undefined;
    readonly emit: EmitChunk;
    readonly toolConcurrency: number;
  },
  args: { readonly input: InferOutput<TInput>; readonly ctx: Ctx },
): Promise<InferOutput<TOutput>> {
  const { prompt } = def;
  const name = prompt.ref;
  // A `.continue()` in flight: its handle is the app's stored data, so it is screened before
  // anything is loaded, reserved or sent.
  const session = claimAgentSession(fixed.owner);
  const { adapted, model, bounds } = picked;
  const resume = session?.resume;
  if (resume !== undefined && resume.user.trim() === '') {
    throw new AgentTranscriptInvalidError({ agent: name, reason: 'the user turn is empty' });
  }
  // What a handle is bound to, read off the declaration and the request — never off the handle:
  // the run's own model and the tools THIS run is offered.
  const binding: TranscriptBinding = {
    agent: name,
    model,
    tools: [...adapted.tools.map((tool) => tool.name), RESPOND],
    org: args.ctx.actor.orgId ?? null,
  };
  const prior = resume === undefined ? undefined : screenTranscript(binding, resume.transcript);
  const limits = limitsOf(picked.budget, prior?.usage);
  const costPerRun = picked.budget?.costPerRun;
  // Armed before anything is loaded: `vars()` is part of the run a deadline bounds.
  const deadline = runDeadline(name, picked.deadlineMs, args.ctx.signal);
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
  const { sampling, emit } = fixed;
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
    });
    // Read when the run ends, not here: the gateway may be what registers the model's row.
    const reportSampling = (): void => {
      span.setAttributes(
        ignoredSamplingAttribute(model, sampling, () => installedGateway()?.samplingWires?.(model)),
      );
    };

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
      ...sampling,
      tools: [...adapted.offered, respond.tool],
      // The caller's own signal, forwarded to the transport. A disconnect has to reach the socket,
      // not just the top of the next turn: a provider call already in flight is the expensive one.
      // The run's deadline is folded into the same signal, so it reaches the socket too.
      signal: deadline.signal,
    };

    // Every provider call below goes through the meter, so whatever ends the run — a ceiling, a
    // deadline, a truncated turn, the caller leaving — is thrown carrying what the run was billed.
    const meter = runMeter();
    // Worst case: the run so far (continuations and nested calls included) plus this request,
    // estimated as the gateway's own reservation will be — at the write rate only where a provider
    // serving the model would mark it. Before every turn, and before a compaction's summary call.
    const assertCost = (next: GenerateRequest): void => {
      if (costPerRun === undefined) return;
      const spent = runTotal(model, prior?.usage, meter.total(), meter.below()).costExact;
      const marked = gateway.marksPromptCache?.(next.model ?? model) === true;
      assertRunCost(costPerRun, spent, estimateCost(next, marked));
    };
    const compacting: Compactor | undefined =
      fixed.compact === undefined
        ? undefined
        : compactor({
            agent: name,
            plan: fixed.compact,
            base,
            model,
            prior: prior?.compacted ?? 0,
            gateway,
            deadline,
            ctx: args.ctx,
            span,
            onCompact: def.onCompact?.bind(def),
            assertCost,
          });
    // What the handle's `compacted` carries: a run with `compact: 'off'` keeps what it was handed.
    const compacted = (): { compacted?: number } => {
      const count = compacting?.count() ?? prior?.compacted ?? 0;
      return count > 0 ? { compacted: count } : {};
    };
    const turnSend: TurnSend = {
      agent: name,
      model,
      base,
      compacting,
      send: (request) => {
        assertCost(request);
        return deadline.guard(meter.call(gateway.generate(request))).catch((error: unknown) => {
          // The caller left mid-call: the aborted socket reads as a provider failure, which is
          // RETRYABLE. Say what happened instead.
          throwIfAborted(args.ctx);
          throw error;
        });
      },
    };
    // Seals and hands over a handle between turns — `undefined`, and free, without the hook.
    const checkpoint = checkpointer(def.onCheckpoint?.bind(def), args, binding, span);
    const landed = (turn: number, messages: readonly AiMessage[], model: string) =>
      checkpoint?.({
        turn,
        messages,
        run: runTotal(model, prior?.usage, meter.total(), meter.below()),
        compacted: compacting?.count() ?? prior?.compacted ?? 0,
      });
    // Where a failure would resume from: the request in flight, and the turns answered so far.
    const at = { messages: [] as readonly AiMessage[], turns: prior?.turns ?? 0 };
    const loop = async (): Promise<InferOutput<TOutput>> => {
      // The actor is read ONCE, from the context the request established, and is the only
      // identity any tool runs as. Nothing below reads an actor out of `result` — a model cannot
      // name the identity it acts as, and a loop that let it would be an escalation primitive.
      const { actor } = args.ctx;
      const tools: ToolRun = {
        tools: adapted.tools,
        ctx: args.ctx,
        actor,
        deadline,
        emit,
        concurrency: fixed.toolConcurrency,
        discloseErrors: def.discloseToolErrors !== false,
        maxTurns,
        chars,
        redact,
        repeated,
      };
      let messages: readonly AiMessage[] =
        prior === undefined ? [{ role: 'user', content: rendered }] : continued(prior, rendered);
      let calls = 0;
      let issues: string | undefined;
      // The issues of the answer the turn in flight is repairing — `onTurn`'s `repairOf`.
      let rejected: readonly string[] | undefined;

      // `maxTurns` counts the run AND its continuations: a handle that used them all takes none.
      for (let turn = at.turns + 1; turn <= maxTurns; turn += 1) {
        at.messages = messages;
        // The caller is gone, so unwind instead of finishing. Every turn re-sends the WHOLE
        // transcript, so a loop that keeps going after a disconnect spends the rest of the run's
        // budget, runs every remaining tool's side effects, and discards the answer.
        throwIfAborted(args.ctx);
        deadline.check();
        // Before the request exists: a turn the window cannot take is compacted first, or refused
        // (`X_AGENT_CONTEXT_EXHAUSTED`) without being sent. A provider that refuses it anyway
        // gets one forced compaction and a re-send (`sendTurn`).
        if (compacting !== undefined) messages = await compacting.fit(messages, turn);
        at.messages = messages;
        const sent = await sendTurn(turnSend, messages, turn, (shorter) => {
          at.messages = shorter;
        });
        messages = sent.messages;
        const { result } = sent;
        at.turns = turn;
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
          run: runTotal(result.model, prior?.usage, meter.total(), meter.below()),
        });
        if (result.text !== '') emit({ type: 'text', turn, text: result.text });
        // Before a tool runs and before the answer is read (`X_LLM_REFUSED`, `X_LLM_TRUNCATED`).
        assertAnswerable(result, name, base);

        if (requested.length > 0) {
          messages = await toolTurn(tools, turn, result, requested, answers, messages);
          calls += requested.length;
          rejected = undefined;
          await landed(turn, messages, result.model);
          continue;
        }

        const parsed = await validateAsync(def.output, respond.read(result));
        if (parsed.issues === undefined) {
          // Kept only for `.run()` / `.continue()`: a plain call leaves nothing behind.
          if (session !== undefined) {
            const usage = runTotal(result.model, prior?.usage, meter.total(), meter.below());
            session.finished = {
              transcript: sealTranscript(binding, {
                messages: [...messages, assistantTurn(result)],
                turns: turn,
                usage: usage.usage,
                ...compacted(),
              }),
              turns: turn,
              usage,
            };
          }
          return parsed.value;
        }
        // A wrong shape gets another turn like any other, because unlike `llm()` this loop has
        // turns left by construction — and unlike a tool result, the correction is the message.
        emit({ type: 'turn', turn, maxTurns });
        rejected = formatIssues(parsed.issues);
        issues = rejected.join('; ');
        messages = [...messages, assistantTurn(result), repairTurn(answers, issues)];
        await landed(turn, messages, result.model);
      }

      at.messages = messages;
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
      meter
        .within(loop)
        .catch((error: unknown) => {
          const failed = meter.fail(error);
          // A failed `.run()` / `.continue()` leaves a handle too: the transcript up to the request
          // the failed turn was answering, with `turns` and `usage` counting what this call was
          // billed. Without it a retry resumes from the OLD handle, which never heard of that spend
          // — six truncated continuations billed six times against a ceiling that saw none of them.
          if (session !== undefined && at.messages.length > 0) {
            const { usage } = runTotal(model, prior?.usage, meter.billed());
            withTranscript(failed, sealTranscript(binding, { ...at, usage, ...compacted() }));
          }
          throw failed;
        })
        .finally(reportSampling),
    );
  });
}
