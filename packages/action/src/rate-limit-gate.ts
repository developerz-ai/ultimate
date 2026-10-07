/**
 * Where a declared `rateLimit:` is spent: once, inside `invoke`, so HTTP, MCP, the in-app agent
 * tool and `.job()` draw on ONE bucket. The store is `@ultimat3/http`'s installed one — the slot
 * `@ultimat3/query` spends from too, filled at boot with the instance `httpServer` is handed.
 */

import type { Ctx } from '@ultimat3/core';
import { asyncContext, isAnonymous } from '@ultimat3/core';
import type { RateLimitDecision } from '@ultimat3/http';
// The bucket maths, the subject precedence and the refusal are all `@ultimat3/http`'s (tier 2):
// a copy here would be a second answer to "what does this limit mean" and "whose bucket is it".
import { installedRateLimitStore, rateLimited, rateLimitSpends, toBucket } from '@ultimat3/http';
import type { ActionRateLimit } from './action';
import type { Surface } from './policy-gate';

/**
 * Who a call chain started from: the address of the request, or the fact that it is a job run.
 * An `agent()` is an action whose handler calls its tools through `invoke` with no address of its
 * own, so without this every anonymous visitor's tool calls shared one `ip:unknown` bucket and one
 * visitor could exhaust it for all. Opened by `invoke`; read by every nested call that has none.
 */
interface CallerFrame {
  readonly address: string | null;
  /** Inside a job run: nested calls are the job's, never a visitor's. */
  readonly job: boolean;
}

const callerFrame = asyncContext<CallerFrame>('the caller frame');

/** Run `fn` with `address` as the inherited caller address; an absent one changes nothing. */
export function withCallerAddress<T>(address: string | null | undefined, fn: () => T): T {
  return typeof address === 'string' && address !== ''
    ? callerFrame.run({ address, job: false }, fn)
    : fn();
}

/**
 * Run `fn` as a job: no inherited address, and every nested call unattributed unless it has an
 * actor or an org of its own. A FRESH frame, not a read of the current one — a worker loop re-armed
 * by `setTimeout` inside a request carries that request's frame, and a tenantless job charged to
 * whichever visitor happened to start the loop is the leak this closes.
 */
export function withJobFrame<T>(fn: () => T): T {
  return callerFrame.run({ address: null, job: true }, fn);
}

/**
 * The subject of a job run nobody attributed — no actor, no tenant. Its own population: sharing
 * `ip:unknown` let a flood of unaddressed anonymous requests park every tenantless job, and the
 * reverse. Still ONE bucket for all such runs, deliberately: unlimited is the abuse this exists for.
 */
const UNATTRIBUTED_JOB = 'job:unattributed';

/**
 * Namespaced, never the bare action name: the HTTP pipeline still spends its `default` bucket
 * under `<route name>|<subject>`, and one key taken against two bucket shapes in one store would
 * corrupt both counters.
 */
const ACTION_SCOPE = 'action';

export interface RateLimitSpendOptions {
  readonly surface: Surface;
  /** The connection address — the only subject an anonymous caller has. */
  readonly clientAddress?: string | null | undefined;
  /** The decision, before a refusal is thrown: how HTTP puts `RateLimit-*` on the answer. */
  readonly onRateLimit?: ((decision: RateLimitDecision) => void) | undefined;
}

/**
 * Spend one token of `limit` for this caller, or throw `X_RATE_LIMITED` — the code, the cause and
 * the `Retry-After` seconds every limit in the framework answers with.
 *
 * `surface: 'server'` spends nothing: that is app code calling its own action in-process (a
 * service composing two, a seed, a test), not a caller arriving from outside. A refused attempt
 * spends nothing either — the token bucket only decrements on an admission — so a job retried
 * into a refusal is not charged for it.
 */
export async function spendActionLimit(
  name: string,
  limit: ActionRateLimit | undefined,
  ctx: Ctx,
  options: RateLimitSpendOptions,
): Promise<void> {
  if (limit === undefined || options.surface === 'server') return;
  const frame = callerFrame.get();
  // A job run, or any call nested inside one (an `agent()` run as a job calling its tools as
  // `'mcp'`): never a visitor's address, and the unattributed bucket rather than `ip:unknown`.
  const inJob = options.surface === 'job' || frame?.job === true;
  const spends = rateLimitSpends(
    {
      actorId: isAnonymous(ctx.actor) ? null : ctx.actor.id,
      // Read off an anonymous actor too: a job run IS the worker's anonymous identity carrying the
      // job's org (`jobRunActor`), and that org is who the run is — charging every tenant's runs
      // to one `ip:unknown` key let one tenant's backlog refuse everyone's.
      orgId: ctx.actor.orgId ?? null,
      ip: options.clientAddress ?? (inJob ? null : (frame?.address ?? null)),
      routeName: `${ACTION_SCOPE}:${name}`,
      ...(inJob ? { unattributed: UNATTRIBUTED_JOB } : {}),
    },
    // The tenant allowance is the HTTP pipeline's (it spends it for every route, a handler-limited
    // one included); counting it here too would charge an HTTP call against the tenant twice.
    { route: name, tenant: null },
  );
  for (const spend of spends) {
    const decision = await installedRateLimitStore().take(
      spend.key,
      toBucket(name, limit),
      1,
      ctx.now().getTime(),
    );
    options.onRateLimit?.(decision);
    if (!decision.allowed) throw rateLimited(spend.key, decision.retryAfterSeconds);
  }
}
