// Single responsibility: put a stub where an action's HANDLER is, through `@ultimat3/action`'s own
// seam — so the stub answers on every surface the action has (a direct call, `.as()`, HTTP, MCP,
// `.job()`, an `llm()`'s `.stream()`) and the policy, the input parse, the rate limit, the meter,
// idempotency and the output parse all still run. Loaded only when an action is stubbed.

import type { AnyAction } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import type { StubWiring } from './stub-script';
import { stubStack } from './stub-stack';
import type { Undo } from './test-scope';

/** Stubs stack per target: a test's over a file's hands the file's back (`stub-stack.ts`). */
const push = stubStack<(args: { readonly input: unknown; readonly ctx: Ctx }) => unknown>();

/** Push `wiring`'s answers over `target`'s handler; the undo pops this stub and no other. */
export async function stubActionHandler(
  target: AnyAction,
  wiring: StubWiring<unknown, unknown>,
): Promise<Undo> {
  const { overrideHandler } = await import('@ultimat3/action/adapter');
  const handle = (args: { readonly input: unknown; readonly ctx: Ctx }) =>
    wiring.answer(args.input, args.ctx.actor);
  return push(target, handle, (top) => overrideHandler(target, top));
}
