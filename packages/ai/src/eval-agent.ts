// The agent arm of `defineEval`: one case is one whole `agent.run()` — its tools, its turns — under
// the gateway the eval was handed, with every tool answered by the eval's double. Split from
// ./evals so the prompt arm and the gate stay one file each.

import type { AnyAction, InvokeOptions } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { assert, serviceActor, stringField } from '@ultimat3/core';
import type { AgentRun } from './agent-continue';
import { agentFactsOf } from './agent-facts';
import type { Gateway } from './gateway';
import type { Prompt } from './prompt';
import { describePrompts } from './prompt';
import type { ToolDouble } from './runtime';
import { withEvalScope } from './runtime';
import type { EvalRun, Scorer } from './scorers';

/** What the agent arm needs of an `agent()` action: its name, and `.run()`. */
export interface EvaluatedAgent<I = unknown> extends AnyAction {
  run(input: I, opts?: InvokeOptions): Promise<AgentRun<unknown>>;
}

/** One agent case: the agent's own input, plus what a good answer looks like. */
export interface AgentEvalCase<I = unknown> {
  readonly name: string;
  readonly input: I;
  /** Reference answer, or the substring/JSON the scorers check for. */
  readonly expected?: string;
}

export interface AgentEvalInput<I = unknown> {
  readonly name: string;
  /** An `agent()` action. Its prompt is the one this eval covers, and its hash keys the baseline. */
  readonly agent: EvaluatedAgent<I>;
  readonly cases: readonly AgentEvalCase<I>[];
  /**
   * One double per tool the model may call. An eval NEVER runs a real tool: a call to a tool with
   * no double here ends the run as `X_EVAL_TOOL_UNDOUBLED`.
   */
  readonly tools: Readonly<Record<string, ToolDouble>>;
  readonly scorers: readonly Scorer[];
  /** As on the prompt arm: `import.meta.resolve('./name.baseline.json')`. */
  readonly baseline: string;
  readonly tolerance: number;
  /** Who each case runs as — for a policy that needs one. Default: the `eval` service actor. */
  readonly actor?: Actor;
}

/** What one case produced, before it is scored. `run` is the agent arm's. */
export type CaseOutcome =
  | { readonly ok: true; readonly output: string; readonly run?: EvalRun }
  | { readonly ok: false; readonly code: string };

/** The default identity of an agent eval: a service, never a person a policy would mistake it for. */
export const EVAL_ACTOR: Actor = serviceActor({ id: 'eval' });

/** The code that means the EVAL is wrong rather than the agent: never scored, always thrown. */
const MISDECLARED = 'X_EVAL_TOOL_UNDOUBLED';

/**
 * The prompt an agent runs on, read off the agent registry. An action `agent()` did not build — or
 * a `named()` twin, which the registry never sees — has none, and an eval of it would cover nothing.
 */
export function agentPrompt(agent: AnyAction, evalName: string): Prompt {
  const ref = agentFactsOf(agent)?.prompt;
  const prompt = ref === undefined ? undefined : describePrompts().find((p) => p.ref === ref);
  assert(
    prompt !== undefined,
    `defineEval "${evalName}" names an agent whose prompt is not registered: an action agent() did not build, a named() twin, or a prompt reset since`,
    `export the agent({ … }) from a module defineApi({ actions }) registers, and pass that action to defineEval({ agent })`,
  );
  return prompt;
}

/**
 * Run one case. A failed run — a loop, `X_AGENT_MAX_TURNS`, an invalid answer — is an OUTCOME the
 * eval scores 0 and reports by code, so a regression never crashes the suite. An undoubled tool
 * call is the one failure rethrown: the eval is misdeclared, and scoring it would let a recording
 * accept a case that tried to run a real tool.
 */
export async function runAgentCase(
  input: AgentEvalInput,
  testCase: AgentEvalCase,
  gateway: Gateway,
): Promise<CaseOutcome> {
  const scope = { eval: input.name, gateway, tools: input.tools, calls: [] };
  try {
    const run = await withEvalScope(scope, () =>
      input.agent.run(testCase.input, { actor: input.actor ?? EVAL_ACTOR }),
    );
    return {
      ok: true,
      output: JSON.stringify(run.output) ?? 'null',
      run: { turns: run.turns, toolCalls: [...scope.calls], usage: run.usage },
    };
  } catch (error) {
    const code = stringField(error, 'code');
    if (code === MISDECLARED) throw error;
    return { ok: false, code: code ?? 'uncoded' };
  }
}
