// Single responsibility: continuing an `agent()` run — the transcript handle a finished run
// leaves, the screen it passes when an app hands it back, the one user turn a continuation
// appends, and `.run()` / `.continue()` on the action.
//
// It exists because the alternative is a whole new run: repairing one section of an article
// re-pays the transcript and every tool result, and the model starts from nothing. A continuation
// re-SENDS the transcript (a provider has no session), but byte-for-byte, so the provider's prompt
// cache reads the prefix back at the cache rate, and no tool runs twice.
//
// The handle is DATA: JSON, stored by the app, version-stamped, bound to one agent, size-capped
// and re-validated block by block on the way in — a tool_use nothing answers is a 400 from every
// provider, and a handle is exactly where one would come from. It carries what the model was
// SENT (already redacted) and what the tools answered, so it is stored like the tool results are.

import type { Action, InvokeOptions } from '@ultimat3/action';
import { asyncContext } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { AgentTranscriptInvalidError } from './agent-errors';
import type { AgentRunUsage } from './agent-usage';
import type { AiContentBlock, AiMessage, TokenUsage } from './provider';
import { RESPOND } from './respond';

/** The handle's format. A handle of another version is refused, never migrated in place. */
export const TRANSCRIPT_VERSION = 1;

/**
 * The most a handle may weigh, in characters of its JSON. Every continuation re-sends all of it,
 * so this is a spend ceiling as much as a storage one: 2,000,000 characters is about 500k tokens
 * of input per turn. A run that outgrew it starts a new run.
 */
export const MAX_TRANSCRIPT_CHARS = 2_000_000;

/**
 * A finished run, as the next one needs it. OPAQUE to an app — store the value (it is JSON), pass
 * it back to `.continue()`; the fields are this package's and may change with `v`.
 */
export interface AgentTranscript {
  readonly v: typeof TRANSCRIPT_VERSION;
  /** The agent's prompt ref (`id@version`). A handle continues the agent that wrote it, only. */
  readonly agent: string;
  /** Everything sent and answered so far, ending on the assistant turn that answered. */
  readonly messages: readonly AiMessage[];
  /** Model turns taken across the run and every continuation — what `maxTurns` counts. */
  readonly turns: number;
  /** Usage across the run and every continuation — what `budget.tokensPerRun` counts. */
  readonly usage: TokenUsage;
}

/** What `.run()` and `.continue()` resolve to: the validated answer and the handle to go on from. */
export interface AgentRun<TOutput> {
  readonly output: TOutput;
  readonly transcript: AgentTranscript;
  /** Turns taken so far, continuations included. */
  readonly turns: number;
  /** Usage and cost so far, continuations included — priced once, from the summed usage. */
  readonly usage: AgentRunUsage;
}

export interface AgentContinuation {
  /** The handle a previous `.run()` or `.continue()` returned. */
  readonly transcript: AgentTranscript;
  /** The one user turn to append: what to change, what was wrong. Redacted like the prompt. */
  readonly user: string;
}

/** An `agent()` action, plus the two calls that keep the transcript. */
export interface AgentAction<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>
  extends Action<TInput, TOutput> {
  /**
   * The SAME action — same policy, audit, rate limit, budget — returning the transcript handle
   * beside the answer. A plain call returns the answer alone and keeps nothing.
   */
  run(input: InferInput<TInput>, opts?: InvokeOptions): Promise<AgentRun<InferOutput<TOutput>>>;
  /**
   * Resume a finished run with one more user turn. `input` is the run's own input again (the
   * policy and `system()` read it); the prompt is NOT re-rendered — the transcript holds it.
   * `maxTurns` and `budget.tokensPerRun` count the run and every continuation together;
   * `deadlineMs` and `maxRepeatedToolCalls` are per call.
   */
  continue(
    input: InferInput<TInput>,
    resume: AgentContinuation,
    opts?: InvokeOptions,
  ): Promise<AgentRun<InferOutput<TOutput>>>;
  named(name: string): AgentAction<TInput, TOutput>;
}

/** One `.run()` / `.continue()` in flight: what to resume from, and where the loop leaves its run. */
export interface AgentSession {
  readonly resume: AgentContinuation | undefined;
  finished: Omit<AgentRun<unknown>, 'output'> | undefined;
}

// Core's lazy seam, like `llm-stream.ts`'s sink: the mark rides the invocation, so the action a
// continuation calls is the one object the registry, the policy and the audit record know.
const sessions = asyncContext<AgentSession>('an agent session');

export const currentAgentSession = (): AgentSession | undefined => sessions.get();

/** `.run()` and `.continue()` for one action: each invokes THAT action inside a session. */
export function sessionCalls<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
): Pick<AgentAction<TInput, TOutput>, 'run' | 'continue'> {
  const invoke = async (
    input: InferInput<TInput>,
    resume: AgentContinuation | undefined,
    opts: InvokeOptions | undefined,
  ): Promise<AgentRun<InferOutput<TOutput>>> => {
    const session: AgentSession = { resume, finished: undefined };
    const output = await sessions.run(session, () => target(input, opts ?? {}));
    const finished = session.finished;
    if (finished === undefined) {
      // The action answered without the loop running: something wrapped it and short-circuited.
      throw new AgentTranscriptInvalidError({
        agent: target.name ?? 'agent',
        reason: 'the action returned without running the agent loop, so there is no transcript',
      });
    }
    return { output, ...finished };
  };
  return {
    run: (input, opts) => invoke(input, undefined, opts),
    continue: (input, resume, opts) => invoke(input, resume, opts),
  };
}

/**
 * The user turn a continuation appends. Every `tool_use` the last assistant turn left open is
 * answered first — the accepted `respond` call among them, which the API insists on seeing
 * answered like any other — and the instruction follows as text.
 */
export function continuationTurn(transcript: AgentTranscript, user: string): AiMessage {
  const last = transcript.messages.at(-1);
  const open =
    last === undefined || typeof last.content === 'string'
      ? []
      : last.content.filter((block) => block.type === 'tool_use');
  if (open.length === 0) return { role: 'user', content: user };
  return {
    role: 'user',
    content: [
      ...open.map((call) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content:
          call.name === RESPOND ? 'Accepted as the answer so far.' : 'Not run: the turn had ended.',
      })),
      { type: 'text' as const, text: user },
    ],
  };
}

/**
 * A handle an app handed back, screened. It came out of the app's storage, so nothing about it is
 * assumed: the version, the agent it belongs to, its weight, and every message — roles
 * alternating from `user`, ending on `assistant`, every block one of the three a tool loop writes,
 * and every `tool_use` answered by the very next message.
 */
export function screenTranscript(agent: string, raw: unknown): AgentTranscript {
  const refuse = (reason: string): never => {
    throw new AgentTranscriptInvalidError({ agent, reason });
  };
  const handle = recordOf(raw) ?? refuse('it is not an object');
  if (handle['v'] !== TRANSCRIPT_VERSION) {
    refuse(`it is version ${String(handle['v'])}, and this build reads ${TRANSCRIPT_VERSION}`);
  }
  if (handle['agent'] !== agent) {
    refuse(`it was written by agent "${String(handle['agent'])}"`);
  }
  let weight: number;
  try {
    weight = JSON.stringify(handle).length;
  } catch {
    return refuse('it is not JSON');
  }
  if (weight > MAX_TRANSCRIPT_CHARS) {
    refuse(`it is ${weight} characters, over the ${MAX_TRANSCRIPT_CHARS} a handle may weigh`);
  }
  const turns = handle['turns'];
  if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1) {
    refuse('its turn count is not a positive whole number');
  }
  const usage = usageOf(handle['usage']) ?? refuse('its usage is not four token counts');
  const messages = Array.isArray(handle['messages']) ? handle['messages'] : refuse('no messages');
  if (messages.length < 2) refuse('it holds fewer than two messages');
  let open: ReadonlySet<string> = new Set();
  const screened = messages.map((entry: unknown, index: number): AiMessage => {
    const message = recordOf(entry) ?? refuse(`messages[${index}] is not an object`);
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (message['role'] !== role) refuse(`messages[${index}] is not a ${role} message`);
    const content = contentOf(message['content']) ?? refuse(`messages[${index}] has no content`);
    const blocks = typeof content === 'string' ? [] : content;
    const answered = new Set(
      blocks.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
    );
    for (const id of open) {
      if (!answered.has(id)) refuse(`messages[${index}] does not answer tool call "${id}"`);
    }
    if (role === 'user' && answered.size > open.size) {
      refuse(`messages[${index}] answers a tool call nothing made`);
    }
    if (role === 'user' && blocks.some((b) => b.type === 'tool_use')) {
      refuse(`messages[${index}] is a user message carrying a tool call`);
    }
    if (role === 'assistant' && answered.size > 0) {
      refuse(`messages[${index}] is an assistant message carrying a tool result`);
    }
    open = new Set(blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
    return { role, content };
  });
  if (screened.length % 2 !== 0) refuse('it does not end on an assistant message');
  return { v: TRANSCRIPT_VERSION, agent, messages: screened, turns: turns as number, usage };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

function usageOf(raw: unknown): TokenUsage | undefined {
  const record = recordOf(raw);
  if (record === undefined) return undefined;
  const count = (key: (typeof COUNTERS)[number]): number | undefined => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const [input, output, read, write] = COUNTERS.map(count);
  if (input === undefined || output === undefined || read === undefined || write === undefined) {
    return undefined;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
}

/** A message's content, rebuilt field by field: a string, or the three block kinds a loop writes. */
function contentOf(raw: unknown): string | readonly AiContentBlock[] | undefined {
  if (typeof raw === 'string') return raw === '' ? undefined : raw;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const blocks: AiContentBlock[] = [];
  for (const entry of raw) {
    const block = recordOf(entry);
    const built = block === undefined ? undefined : blockOf(block);
    if (built === undefined) return undefined;
    blocks.push(built);
  }
  return blocks;
}

function blockOf(block: Record<string, unknown>): AiContentBlock | undefined {
  const { type, text, id, name, tool_use_id: answers, content } = block;
  if (type === 'text' && typeof text === 'string' && text !== '') return { type, text };
  const input = recordOf(block['input']);
  if (type === 'tool_use' && typeof id === 'string' && typeof name === 'string' && input) {
    return { type, id, name, input };
  }
  if (type === 'tool_result' && typeof answers === 'string' && typeof content === 'string') {
    return {
      type,
      tool_use_id: answers,
      content,
      ...(block['is_error'] === true ? { is_error: true } : {}),
    };
  }
  return undefined;
}
