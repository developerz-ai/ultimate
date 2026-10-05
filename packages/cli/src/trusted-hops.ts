// How many proxies sit in front of this process, read from `TRUSTED_PROXY_HOPS`. Its own module
// so both the web role (`role-start.ts`) and the sync node (`role-sync.ts`) read it without one
// importing the other — `role-start` imports `role-sync`, and the reverse edge was a cycle.

import { MAX_PROXY_HOPS } from '@ultimat3/http';
import type { Env } from './runtime-bindings';
import { TrustedProxyHopsInvalidError } from './trusted-hops-error';

/**
 * How many proxies is too many, and the number is **`@ultimat3/http`'s**, not this file's.
 *
 * `defineHttpConfig` screens the same setting — `assertFiniteCount('trustedProxyHops', …,
 * MAX_PROXY_HOPS)` — and this screen used to say 16 where that one says 64, so one setting had two
 * ceilings and a deployment behind 20 hops was accepted by the library and refused by the boot.
 * Widened rather than narrowed: tightening the library would break a shipped public API, while
 * this end only ever refused topologies http already supports.
 *
 * It was a duplicated literal until 2026-08-26, because `@ultimat3/http` did not export the
 * constant. It does now, so this file IMPORTS it — a downward edge, tier 5 to tier 2 — and there is
 * no second number left to drift. `runtime-overrides.test.ts` still probes both screens for the
 * highest count each accepts, and it is kept rather than deleted: it compares BEHAVIOUR, so it also
 * catches the two disagreeing for a reason a shared constant cannot fix, such as one side gaining a
 * range check the other does not have.
 */

/**
 * How many proxies append to `x-forwarded-for` between the client and this process, or `null`
 * when nothing in front of it is trusted.
 *
 * Read from the environment and not from `app.config.ts`, for the reason `PORT` and `ROLE` are: it
 * is a fact about the DEPLOYMENT — one image runs behind an ingress in one cluster and behind
 * nothing on a laptop — and an app that hardcoded it would be wrong in one of the two. `x dev`
 * sets neither and gets `trustProxy: false`, which is correct: there is no proxy.
 *
 * Without this seam a container behind an ingress reads `ctx.ip` as the ingress's own socket
 * address on every request, so the rate limiter keys the entire fleet's anonymous traffic into ONE
 * bucket and a single scanner 429s every real signup.
 */
export function trustedHopsFromEnv(env: Env): number | null {
  const raw = env['TRUSTED_PROXY_HOPS']?.trim();
  if (raw === undefined || raw === '') return null;
  const hops = Number(raw);
  // A malformed count is refused rather than defaulted: reading the header at the wrong index is
  // trusting a value the client typed, which is the failure trusting a proxy exists to avoid.
  if (!/^\d+$/.test(raw) || !Number.isInteger(hops) || hops < 1 || hops > MAX_PROXY_HOPS) {
    throw new TrustedProxyHopsInvalidError({ value: raw });
  }
  return hops;
}
