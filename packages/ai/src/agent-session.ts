// Single responsibility: `.run()` / `.continue()` on an agent's action — the ambient session a call
// opens, the one claim the declaring agent may make on it, and the two calls themselves. Split
// from ./agent-continue (the handle) and ./agent (the loop) at their line ceilings.

import type { Action, InvokeOptions } from '@ultimat3/action';
import { asyncContext } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { AgentAction, AgentContinuation, AgentRun } from './agent-continue';
import { AgentTranscriptInvalidError } from './agent-errors';

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
