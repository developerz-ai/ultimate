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
import {
  asyncContext,
  CURSOR_SECRET_FIX,
  CURSOR_SECRET_KEY,
  canonicalJson,
  currentSigningSecret,
  fingerprint,
  isProduction,
  isUltimateError,
  usesDevCursorSecret,
} from '@ultimat3/core';
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
 * A run, as the next call needs it. OPAQUE to an app — store the value (it is JSON), pass it back
 * to `.continue()`; the fields are this package's and may change with `v`.
 *
 * SIGNED, and bound to what must not change between the run and its continuation. The handle
 * carries the run's own ceilings (`turns`, `usage`) and its transcript, and it travels through an
 * app's storage — so every field is under an HMAC, and a handle anyone edited is refused.
 */
export interface AgentTranscript {
  readonly v: typeof TRANSCRIPT_VERSION;
  /** The agent's prompt ref (`id@version`). A handle continues the agent that wrote it, only. */
  readonly agent: string;
  /** The model the run was on. A transcript is not carried to another one. */
  readonly model: string;
  /** A fingerprint of the tool names the agent declared when the handle was written. */
  readonly tools: string;
  /** The tenant of the actor the run was FOR, or `null`. Another org's actor is refused. */
  readonly org: string | null;
  /** Everything sent and answered so far. */
  readonly messages: readonly AiMessage[];
  /** Model turns taken across the run and every continuation — what `maxTurns` counts. */
  readonly turns: number;
  /** Usage across the run and every continuation — what `budget.tokensPerRun` counts. */
  readonly usage: TokenUsage;
  /**
   * Compactions applied so far, continuations included — present only once there was one, so a
   * run that never compacted writes exactly the handle it always did. Its first message then holds
   * the prompt and a `[compacted: …]` summary block (`./agent-compact`).
   */
  readonly compacted?: number;
  /** HMAC-SHA256 over the canonical JSON of every field above (`sealTranscript`). */
  readonly sig: string;
}

/** What a handle is bound to: read off the DECLARATION and the request, never off the handle. */
export interface TranscriptBinding {
  readonly agent: string;
  readonly model: string;
  /** Every tool name the agent offers, `respond` included. */
  readonly tools: readonly string[];
  readonly org: string | null;
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
  /**
   * Which DECLARATION this session was opened for. The session rides the async context, so every
   * agent that runs underneath — a tool that calls another agent — can see it; only the one whose
   * token this is may take it, and only once.
   */
  readonly owner: object;
  claimed: boolean;
  readonly resume: AgentContinuation | undefined;
  finished: Omit<AgentRun<unknown>, 'output'> | undefined;
}

// Core's lazy seam, like `llm-stream.ts`'s sink: the mark rides the invocation, so the action a
// continuation calls is the one object the registry, the policy and the audit record know.
const sessions = asyncContext<AgentSession>('an agent session');

/**
 * The session of THIS run, taken — or `undefined` for a plain call, and for any other agent
 * running under somebody else's `.run()` / `.continue()`: a nested agent starts fresh.
 */
export function claimAgentSession(owner: object): AgentSession | undefined {
  const session = sessions.get();
  if (session === undefined || session.owner !== owner || session.claimed) return undefined;
  session.claimed = true;
  return session;
}

/** `.run()` and `.continue()` for one action: each invokes THAT action inside a session. */
export function sessionCalls<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
  /** The declaration's own token: `named()` twins share it, no other agent has it. */
  owner: object,
): Pick<AgentAction<TInput, TOutput>, 'run' | 'continue'> {
  const invoke = async (
    input: InferInput<TInput>,
    resume: AgentContinuation | undefined,
    opts: InvokeOptions | undefined,
  ): Promise<AgentRun<InferOutput<TOutput>>> => {
    const session: AgentSession = { owner, claimed: false, resume, finished: undefined };
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
 * The transcript with ONE user turn appended. Every `tool_use` the last assistant turn left open is
 * answered first — the accepted `respond` call among them, which the API insists on seeing
 * answered like any other — and the instruction follows as text.
 *
 * A handle from a FAILED call ends on a user message (the request the failed turn was answering).
 * Roles must alternate, so the instruction joins that message as one more text block.
 */
export function continued(transcript: AgentTranscript, user: string): readonly AiMessage[] {
  const { messages } = transcript;
  const last = messages.at(-1);
  const text = { type: 'text' as const, text: user };
  if (last === undefined) return [{ role: 'user', content: user }];
  if (last.role === 'user') {
    const blocks =
      typeof last.content === 'string'
        ? [{ type: 'text' as const, text: last.content }]
        : last.content;
    return [...messages.slice(0, -1), { role: 'user', content: [...blocks, text] }];
  }
  const open =
    typeof last.content === 'string' ? [] : last.content.filter((b) => b.type === 'tool_use');
  if (open.length === 0) return [...messages, { role: 'user', content: user }];
  const answers = open.map((call) => ({
    type: 'tool_result' as const,
    tool_use_id: call.id,
    content:
      call.name === RESPOND ? 'Accepted as the answer so far.' : 'Not run: the turn had ended.',
  }));
  return [...messages, { role: 'user', content: [...answers, text] }];
}

/** Domain separation: this key signs transcripts and nothing else the same secret signs. */
const PURPOSE = 'ultimate.ai.agent-transcript.v1';

const toolsMark = (names: readonly string[]): string => fingerprint([...names].sort());

function signatureOf(fields: Omit<AgentTranscript, 'sig'>): string {
  // The framework's one signing secret (`ULTIMATE_CURSOR_SECRET`), under this file's own label.
  return new Bun.CryptoHasher('sha256', currentSigningSecret())
    .update(`${PURPOSE}\n${canonicalJson(fields)}`)
    .digest('hex');
}

/** A handle for `state`, bound and signed. The one place a transcript is written. */
export function sealTranscript(
  binding: TranscriptBinding,
  state: Pick<AgentTranscript, 'messages' | 'turns' | 'usage' | 'compacted'>,
): AgentTranscript {
  const fields: Omit<AgentTranscript, 'sig'> = {
    v: TRANSCRIPT_VERSION,
    agent: binding.agent,
    model: binding.model,
    tools: toolsMark(binding.tools),
    org: binding.org,
    messages: state.messages,
    turns: state.turns,
    usage: state.usage,
    ...(state.compacted === undefined || state.compacted < 1 ? {} : { compacted: state.compacted }),
  };
  return { ...fields, sig: signatureOf(fields) };
}

/** The `meta` key a failed `.run()` / `.continue()` carries its handle under. */
export const TRANSCRIPT_META = 'transcript';

/**
 * The handle a FAILED `.run()` / `.continue()` left: the transcript up to the request the failed
 * turn was answering, with `turns` and `usage` counting everything the failed call was billed. A
 * job stores THIS one — continuing from the handle it started with forgets that spend, and is
 * then bounded by the actor and org ceilings alone. `undefined` when the failure left none.
 */
export function transcriptOf(error: unknown): AgentTranscript | undefined {
  if (!isUltimateError(error)) return undefined;
  const raw = recordOf(error.meta?.[TRANSCRIPT_META]);
  return raw !== undefined && typeof raw['sig'] === 'string'
    ? (raw as unknown as AgentTranscript)
    : undefined;
}

/** `error`, carrying `transcript` on `meta.transcript` — written in place, as its bill is. */
export function withTranscript(error: unknown, transcript: AgentTranscript): unknown {
  if (isUltimateError(error)) {
    try {
      Reflect.set(error, 'meta', { ...error.meta, [TRANSCRIPT_META]: transcript });
    } catch {
      // A frozen error keeps the meta it was thrown with.
    }
  }
  return error;
}

/**
 * A handle an app handed back, screened — before anything is loaded, reserved or sent. In order:
 * its weight; its SIGNATURE (so `turns`, `usage` and every message are the ones this process
 * wrote); what it is bound to — the agent, the model, the declared tools, the actor's tenant; and
 * then its shape anyway, because a signed handle from an older build is still an older build's.
 */
export function screenTranscript(binding: TranscriptBinding, raw: unknown): AgentTranscript {
  const { agent } = binding;
  const refuse = (reason: string, fix?: string): never => {
    throw new AgentTranscriptInvalidError({ agent, reason, ...(fix === undefined ? {} : { fix }) });
  };
  // A handle signed with the shipped development key is one anybody can forge.
  if (isProduction() && usesDevCursorSecret()) {
    refuse(
      `this process signs with the shipped development key, so a handle cannot be trusted — set ${CURSOR_SECRET_KEY}`,
      CURSOR_SECRET_FIX,
    );
  }
  const handle = recordOf(raw) ?? refuse('it is not an object');
  if (handle['v'] !== TRANSCRIPT_VERSION) {
    refuse(`it is version ${String(handle['v'])}, and this build reads ${TRANSCRIPT_VERSION}`);
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
  const { sig, ...fields } = handle;
  let expected: string;
  try {
    expected = signatureOf(fields as unknown as Omit<AgentTranscript, 'sig'>);
  } catch {
    return refuse('it is not JSON');
  }
  if (typeof sig !== 'string' || !sameText(sig, expected)) {
    refuse('its signature does not match — it was edited, or the signing secret rotated');
  }
  if (handle['agent'] !== agent) refuse(`it was written by agent "${String(handle['agent'])}"`);
  if (handle['model'] !== binding.model) {
    refuse(
      `it was written on model "${String(handle['model'])}", and this call is on "${binding.model}"`,
    );
  }
  if (handle['tools'] !== toolsMark(binding.tools)) {
    refuse('the agent declared a different set of tools when it was written');
  }
  if (handle['org'] !== binding.org) refuse('it was written for another tenant');
  const turns = handle['turns'];
  if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 0) {
    refuse('its turn count is not a whole number');
  }
  const usage = usageOf(handle['usage']) ?? refuse('its usage is not four token counts');
  const compacted = handle['compacted'];
  if (
    compacted !== undefined &&
    (typeof compacted !== 'number' || !Number.isInteger(compacted) || compacted < 1)
  ) {
    refuse('its compaction count is not a whole number above zero');
  }
  const messages = Array.isArray(handle['messages']) ? handle['messages'] : refuse('no messages');
  if (messages.length < 1) refuse('it holds no message');
  const declared = new Set(binding.tools);
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
    for (const block of blocks) {
      if (block.type === 'tool_use' && !declared.has(block.name)) {
        refuse(`messages[${index}] calls "${block.name}", which this agent does not declare`);
      }
    }
    open = new Set(blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
    return { role, content };
  });
  return {
    v: TRANSCRIPT_VERSION,
    agent,
    model: binding.model,
    tools: handle['tools'] as string,
    org: binding.org,
    messages: screened,
    turns: turns as number,
    usage,
    ...(compacted === undefined ? {} : { compacted: compacted as number }),
    sig: sig as string,
  };
}

/** Constant-time over equal lengths: a signature check must not say how much of it matched. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
