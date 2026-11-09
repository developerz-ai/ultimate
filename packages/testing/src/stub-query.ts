// Single responsibility: put a stub where a query's ROWS come from, through `@ultimat3/query`'s own
// seam — the actor check, the rate limit, the input parse and the policy still run on every surface
// (a direct call, `.as()`, HTTP, MCP, a live read), and the stub answers instead of the SQL and the
// cache. Loaded only when a query is stubbed.

import type { Ctx } from '@ultimat3/core';
import type { AnyQuery } from '@ultimat3/query';
import type { StubWiring } from './stub-script';
import { stubStack } from './stub-stack';
import type { Undo } from './test-scope';

/** Stubs stack per target: a test's over a file's hands the file's back (`stub-stack.ts`). */
const push =
  stubStack<(args: { readonly input: unknown; readonly ctx: Ctx }) => Promise<readonly object[]>>();

/** Push `wiring`'s rows over `target`'s reads; the undo pops this stub and no other. */
export async function stubQueryRows(
  target: AnyQuery,
  wiring: StubWiring<unknown, readonly object[]>,
): Promise<Undo> {
  const { overrideRows } = await import('@ultimat3/query/adapter');
  const handle = (args: { readonly input: unknown; readonly ctx: Ctx }) =>
    wiring.answer(args.input, args.ctx.actor);
  return push(target, handle, (top) => overrideRows(target, top));
}
