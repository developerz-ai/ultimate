/**
 * An agent run, streamed. `agent()` declares `stream: AgentChunk`, so a page asking its route for
 * `text/event-stream` sees each turn as it lands — the turn's text, each tool call and its outcome,
 * the turn's end — instead of a spinner for the whole loop. Facts only: no arguments, no tool
 * output, no transcript, the same line `onTurn` holds. `done` is the action's own final frame.
 */

import { t } from '@ultimat3/schema';

export const AgentChunk = t.discriminatedUnion(
  'type',
  t.object({ type: t.literal('text'), turn: t.number, text: t.string }),
  t.object({ type: t.literal('tool_call'), turn: t.number, id: t.string, name: t.string }),
  t.object({
    type: t.literal('tool_result'),
    turn: t.number,
    id: t.string,
    name: t.string,
    isError: t.boolean,
  }),
  t.object({ type: t.literal('turn'), turn: t.number, maxTurns: t.number }),
);

export type AgentChunkValue =
  | { readonly type: 'text'; readonly turn: number; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly turn: number;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool_result';
      readonly turn: number;
      readonly id: string;
      readonly name: string;
      readonly isError: boolean;
    }
  | { readonly type: 'turn'; readonly turn: number; readonly maxTurns: number };

export type EmitChunk = (chunk: AgentChunkValue) => void;

/**
 * A callback-driven run as the async generator a stream-declaring action's `handle` is: chunks are
 * queued as `run` emits them and yielded in order; the run's answer is the generator's return.
 * A consumer that stops early (`return()`) leaves `run` to the context's own abort.
 */
export async function* streamOf<T>(
  run: (emit: EmitChunk) => Promise<T>,
): AsyncGenerator<AgentChunkValue, T, undefined> {
  const queue: AgentChunkValue[] = [];
  let wake: (() => void) | undefined;
  const emit: EmitChunk = (chunk) => {
    queue.push(chunk);
    wake?.();
  };
  let settled = false;
  const finished = run(emit).finally(() => {
    settled = true;
    wake?.();
  });
  // Observed here so a failure is never unhandled while the loop is waiting; rethrown below.
  finished.catch(() => undefined);
  for (;;) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    if (settled) return await finished;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
}
