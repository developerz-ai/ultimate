// What an `agent()` IS, published for the manifest — turns, tools, budget, model, prompt hash.
//
// Nothing agent-shaped was visible anywhere before this: an agent projects to `ActionDescriptor`
// like every other action, and that descriptor deliberately knows nothing about turns or tools,
// so "which agents does this app have, how far can each one loop, and what may it call" had no
// answer outside reading the source. Same shape as `describePrompts()` / `describeEvals()`, and
// deliberately NOT a new `ActionDescriptor` field: @ultimat3/action is tier 3 and knows nothing
// about models.

import type { AnyAction } from '@ultimat3/action';
import type { Money } from '@ultimat3/money';

/** The declared ceilings, flattened so a manifest row is plain JSON. `null` is "not declared". */
export interface AgentBudgetFact {
  readonly tokensIn: number | null;
  readonly tokensPerRun: number | null;
  readonly costPerCall: Money | null;
}

export interface AgentFact {
  /** The export name registration stamped — the same name `.tool()` and `tools/call` answer to. */
  readonly name: string;
  readonly prompt: string;
  readonly promptId: string;
  /**
   * The prompt's content hash. An agent's behaviour is its prompt, so a row without one records
   * which agent ran and not which agent it was — the same reason every eval result carries it.
   */
  readonly promptHash: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxToolResultChars: number;
  /** Tool names, sorted — the catalogue this agent may call, which is its blast radius. */
  readonly tools: readonly string[];
  readonly budget: AgentBudgetFact;
  /** Whether the agent itself is offered as a tool, so a supervisor could call it. */
  readonly mcp: boolean;
}

/**
 * Keyed by the action, and the facts are a THUNK: every name in a row — the agent's and its
 * tools' — is stamped by `registerAction` at boot, long after `agent()` ran at module scope.
 * Reading them here rather than at declaration is what makes a row name what an app can call.
 */
const registry = new Map<AnyAction, () => Omit<AgentFact, 'name'>>();

export function registerAgentFact(target: AnyAction, facts: () => Omit<AgentFact, 'name'>): void {
  registry.set(target, facts);
}

/**
 * Every registered agent, by name.
 *
 * An agent still carrying no name is left out, and that is not a silent drop: a name is stamped by
 * `registerAction`, an action without one reaches no route, no tool catalogue and no queue, so
 * there is no capability for a row to describe. `named()` builds a TWIN rather than naming in
 * place — registration names in place — so an agent renamed that way is absent for the same
 * reason. Register it instead: `registerAction('supportAgent', support)`.
 */
export function describeAgents(): readonly AgentFact[] {
  return [...registry.entries()]
    .filter(([target]) => target.name !== '')
    .map(([target, facts]) => ({ name: target.name, ...facts() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Test-only reset. A module-level registry otherwise leaks between test files. */
export function resetAgents(): void {
  registry.clear();
}
