// The X_AGENT_* codes an UNATTENDED run needs, and the one a continuation's handle is refused by, apart from ./errors only because one file has
// one job and that catalogue is at its ceiling — the split `hive-errors.ts` made. The codes, their
// titles and the single `registerErrorCodes` call stay in ./errors.

import { UltimateError } from '@ultimat3/core';

/**
 * The loop asked for the same tool calls and read the same results, turn after turn.
 *
 * Call AND result, never the call alone: polling one tool with one argument is legitimate while
 * what comes back keeps changing, and it stops being progress the moment it does not. A turn that
 * repeats both can only be followed by a turn that repeats both, so every further turn buys the
 * same non-answer over a transcript that is one turn longer.
 */
export class AgentToolLoopError extends UltimateError {
  constructor(input: {
    agent: string;
    /** Laps of the cycle. */
    repeats: number;
    /** Turns in one lap: 1 is the same turn over and over, 2 is A,B,A,B. */
    cycle: number;
    tools: readonly string[];
  }) {
    super({
      code: 'X_AGENT_TOOL_LOOP',
      cause:
        input.cycle === 1
          ? `agent "${input.agent}" made the same tool calls (${input.tools.join(', ')}) and read the same results ${input.repeats} turns in a row`
          : `agent "${input.agent}" went round the same ${input.cycle} tool turns (${input.tools.join(', ')}), reading the same results, ${input.repeats} times in a row`,
      fix: 'maxRepeatedToolCalls: 5   # on the agent, ONLY for a tool that is polled and answers identically while it waits — otherwise tell the template what to do when a tool result does not change, then bump its version',
      meta: { agent: input.agent, repeats: input.repeats, cycle: input.cycle, tools: input.tools },
    });
  }
}

/**
 * The run was still going when its declared `deadlineMs` elapsed. Distinct from `X_ABORTED` — the
 * caller did not leave, the declaration ran out — and from `X_AGENT_MAX_TURNS`, because the fix is
 * about wall clock: a slow tool or a slow model, not a loop with no exit.
 */
export class AgentDeadlineError extends UltimateError {
  constructor(input: { agent: string; deadlineMs: number }) {
    super({
      code: 'X_AGENT_DEADLINE',
      cause: `agent "${input.agent}" was still running after its ${input.deadlineMs}ms deadline; whatever was in flight (setup, a model call or a tool) was signalled to stop, and no further turn or tool was started`,
      fix: 'deadlineMs: 300_000   # on the agent, only once a trace shows the run converging — otherwise lower maxTurns, or shorten the slow tool the agent.turn span events name',
      meta: { agent: input.agent, deadlineMs: input.deadlineMs },
    });
  }
}

/**
 * A transcript handle handed to `.continue()` did not pass its screen. The handle is data an app
 * stored and read back, so it is refused BEFORE anything is loaded, reserved or sent: a transcript
 * with a tool call nothing answers is a 400 from every provider, and one from another agent or
 * another format would resume a conversation this declaration never had.
 */
export class AgentTranscriptInvalidError extends UltimateError {
  constructor(input: { agent: string; reason: string }) {
    super({
      code: 'X_AGENT_TRANSCRIPT_INVALID',
      cause: `agent "${input.agent}" cannot continue from the transcript it was given: ${input.reason}`,
      fix: 'agent.run(input, { ctx })   # start a new run and store ITS transcript — pass back exactly the value .run() or .continue() returned, from the same agent and prompt version',
      meta: { agent: input.agent },
    });
  }
}
