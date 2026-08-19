// The one place this package installs an ambient identity for a tool call.
//
// Its own file because both callers — a hand-written app tool and a projected action — must answer
// the same way on both transports, and two call sites each choosing `withChildContext` is how they
// came to answer differently by transport.

import type { Actor } from '@ultimat3/core';
import { createContext, hasContext, runWithContext, withChildContext } from '@ultimat3/core';

/**
 * Run `fn` with `actor` as the ambient identity, whether or not a request is already in flight.
 *
 * `withChildContext` alone is wrong here, and was: it calls `useContext()`, which throws
 * `X_NO_CONTEXT` when nothing is in flight — and NOTHING in this package installs a root context.
 * Over `x mcp serve` (stdio) there is no surrounding request, so every app tool call and every
 * projected action answered `X_NO_CONTEXT` instead of running. Over HTTP the transport's request
 * supplies the parent, and the child is what keeps the policy subject and whatever the handler
 * reads off `ctx.actor` the same identity by construction rather than by two call sites agreeing.
 */
export function asCallerContext<T>(actor: Actor, fn: () => T): T {
  return hasContext()
    ? withChildContext({ actor }, fn)
    : runWithContext(createContext({ actor }), fn);
}
