// Single responsibility: `onCheckpoint` — a signed handle for the run so far, handed to the app
// after a turn's tool results (or its correction) land and before the next turn is bought, so a
// worker that dies mid-run leaves something to `.continue()` from. Sealed only when the hook is
// declared: a run without it pays nothing and is byte-identical.

import type { Span } from '@ultimat3/core';
import type { AgentCheckpoint, TranscriptBinding } from './agent-continue';
import { sealTranscript } from './agent-continue';
import type { AgentRunUsage } from './agent-usage';
import type { AiMessage } from './provider';

/** What one checkpoint is cut from: the transcript after turn `turn`, and the run's total. */
export interface CheckpointState {
  readonly turn: number;
  readonly messages: readonly AiMessage[];
  readonly run: AgentRunUsage;
  /** Compactions so far, continuations included — signed, like a finished handle's. */
  readonly compacted: number;
}

export type Checkpointer = (state: CheckpointState) => Promise<void>;

/**
 * `undefined` without a hook — the loop then seals nothing. Awaited, and a throw fails the run, as
 * `onTurn`'s does: a checkpoint that silently stopped reads exactly like one that works.
 */
export function checkpointer<A>(
  hook: ((event: AgentCheckpoint, args: A) => void | Promise<void>) | undefined,
  args: A,
  binding: TranscriptBinding,
  span: Span,
): Checkpointer | undefined {
  if (hook === undefined) return undefined;
  return async ({ turn, messages, run, compacted }) => {
    const transcript = sealTranscript(binding, {
      messages,
      turns: turn,
      usage: run.usage,
      ...(compacted > 0 ? { compacted } : {}),
    });
    span.addEvent('agent.checkpoint', { 'agent.checkpoint.turn': turn });
    await hook({ turn, transcript, run }, args);
  };
}
