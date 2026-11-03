/**
 * The gates a named tool passes on its way to `invoke`, keyed by name because a tool is named across
 * both surfaces. Tier 3, the lowest `@ultimat3/mcp` (which registers one) and `@ultimat3/ai` (whose
 * adapter reads one) can both reach, since those two may not import each other.
 */

import type { Actor } from '@ultimat3/core';
import {
  actorOf,
  ctxOf,
  hasContext,
  runWithContext,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import type { WireJsonSchema } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { guardActionBeforeInput } from './policy-gate';

/** One tool call, as a gate reads it: raw arguments, and the schema that tool publishes for them. */
export interface ToolGateCall {
  readonly tool: string;
  readonly args: unknown;
  readonly inputSchema: WireJsonSchema | undefined;
  readonly actor: Actor;
}

/** Answers by running `run`, or by throwing the refusal the caller reads instead. */
export type ToolGate = (call: ToolGateCall, run: () => Promise<unknown>) => Promise<unknown>;

const gates = new Map<string, ToolGate>();

/**
 * First registered keeps the name; a later one for it is a no-op, never an error. Two
 * `mcpConfirmations` on one tool are legal, since each MCP server holds its own, and a duplicate
 * check by identity would trip on the fresh closure a re-evaluated module hands in.
 */
export function registerToolGate(names: readonly string[], gate: ToolGate): void {
  for (const name of names) if (!gates.has(name)) gates.set(name, gate);
}

/** Read at CALL time: the module declaring a gate may evaluate after the agent listing the tool. */
export function toolGateFor(name: string): ToolGate | undefined {
  return gates.get(name);
}

/** Sorted, so what two processes registered compares as data (`X_ROLE_LOAD_INCOMPLETE`). */
export function gatedToolNames(): readonly string[] {
  return [...gates.keys()].sort();
}

const noted = new Set<string>();

/**
 * Tools no registry holds: a hand-written MCP tool, an agent's in-process one. Noted by what declares
 * them, so the `manifest` step can tell a gate on one of those from a gate on a typo, which holds
 * nothing and lets the real tool run (`X_MCP_CONFIRMATION_TOOL_UNKNOWN`).
 */
export function noteToolNames(names: readonly string[]): void {
  for (const name of names) noted.add(name);
}

export function knownToolNames(): readonly string[] {
  return [...noted].sort();
}

/**
 * `resetActions`' half of a reload, and only that. `resetActions` is on the barrel because 48 files
 * outside this package reach it there and no test-only entry exists, so it does empty these tables:
 * a test resetting after each case must re-declare any module-level gate, or later cases run ungated.
 */
export function clearToolGates(): void {
  gates.clear();
  noted.clear();
}

/**
 * Run `fn` with `actor` as the ambient identity, whether or not a request is in flight.
 * `withChildContext` alone calls `useContext()`, which throws `X_NO_CONTEXT` with nothing in flight:
 * over `x mcp serve` (stdio) every tool call answered that instead of running. With a request, the
 * child keeps the policy subject and what the handler reads off `ctx.actor` one identity.
 */
export function asCallerContext<T>(actor: Actor, fn: () => T): T {
  return hasContext() ? withChildContext({ actor }, fn) : runWithContext(ctxOf({ actor }), fn);
}

/**
 * The opening gate of `invoke`, asked earlier: throws for a caller the action's policy refuses before
 * reading the input. Both tool surfaces ask it, so such a caller opens no row for a person to look at.
 */
export function admitActionCaller(target: AnyAction, name: string): (actor: Actor) => void {
  return (actor) =>
    asCallerContext(actor, () => {
      const ctx = useContext();
      guardActionBeforeInput(target.policy, { actor: actorOf(ctx), ctx, action: name }, 'mcp');
    });
}
