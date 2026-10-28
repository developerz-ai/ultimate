// Single responsibility: which queue one claim pass asks, in what order and for how many — under
// each queue's own slots AND the process cap (`maxInFlight`, `worker-process-cap.ts`). The worker
// owns what a claim DOES; this owns the plan, so the fairness rule is one file a test can drive.
//
// THE FAIRNESS RULE. Queues are asked in the worker's order ROTATED to start after the last queue
// that was given a job, and a pass splits the room it has left evenly over the queues it has not
// asked yet (`ceil(room / queues left)`); a queue that filled its share is asked again, in the
// same order, while room is left. So a free slot goes to some queue with work whenever any has
// it, and a backlogged queue cannot monopolise a capped worker: each slot a finish frees goes to
// the next queue in turn.

import { type ClaimAsk, claimAsks } from './worker-admit';

/** What one claim answered: runs ADMITTED (a shed or a refusal holds nothing), per queue. */
export type ClaimAnswer = ReadonlyMap<string, number>;

export interface ClaimSweepInput {
  /** The worker's queues, in its own order. */
  readonly queues: readonly string[];
  /** A queue's free slots, re-read before every ask — a run admitted or finished moves it. */
  readonly freeSlots: (queue: string) => number;
  /** Room under the process cap, re-read likewise; `Infinity` with none. */
  readonly processFree: () => number;
  /** The loop is idling: one statement over every open queue (`claimAsks`). */
  readonly idle: boolean;
  /** May the pass still claim? Re-read per ask — a `stop()` between two queues is a stop now. */
  readonly claiming: () => boolean;
  readonly claim: (ask: ClaimAsk) => Promise<ClaimAnswer>;
}

export interface ClaimSweep {
  /** One pass. Resolves once every ask it made has been answered. */
  pass(input: ClaimSweepInput): Promise<void>;
}

/** `queues` from `start`, wrapping. */
const rotated = (queues: readonly string[], start: number): readonly string[] =>
  queues.length === 0
    ? queues
    : [...queues.slice(start % queues.length), ...queues.slice(0, start % queues.length)];

/** The cursor lives across passes: that is what makes the rotation a turn, not a shuffle. */
export function createClaimSweep(): ClaimSweep {
  let cursor = 0;

  const served = (queues: readonly string[], answer: ClaimAnswer): void => {
    for (const [queue, admitted] of answer) {
      if (admitted <= 0) continue;
      const index = queues.indexOf(queue);
      if (index !== -1) cursor = index + 1;
    }
  };

  return {
    async pass(input) {
      const order = rotated(input.queues, cursor);
      if (input.idle) {
        const room = input.processFree();
        if (room <= 0) return;
        for (const ask of claimAsks(order, input.freeSlots, true)) {
          if (!input.claiming()) return;
          served(input.queues, await input.claim({ ...ask, limit: Math.min(ask.limit, room) }));
        }
        return;
      }
      let asking = order;
      while (asking.length > 0) {
        const again: string[] = [];
        for (const [index, queue] of asking.entries()) {
          if (!input.claiming()) return;
          const room = input.processFree();
          if (room <= 0) return;
          const share = Math.ceil(room / (asking.length - index));
          const free = Math.max(0, input.freeSlots(queue));
          const limit = Math.min(free, share);
          if (limit <= 0) continue;
          const answer = await input.claim({ queues: [queue], limit });
          served(input.queues, answer);
          // Its SHARE bound it, not its slots, and it filled it with runs that STARTED: it may
          // hold more, for room a quieter queue left. A shed is not "more" — asking again would
          // claim the same capped rows back and forth. With no cap the share never binds, so an
          // uncapped pass is one ask per queue, as it always was.
          if (limit < free && (answer.get(queue) ?? 0) >= limit) again.push(queue);
        }
        asking = again;
      }
    },
  };
}
