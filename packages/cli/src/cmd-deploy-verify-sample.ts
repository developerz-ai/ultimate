// One `GET /readyz` against an origin, as `x deploy verify` and `x status` both read it: a fresh
// connection, uncached, a redirect tallied rather than followed — the status, the build header, the
// role a health port names. One reader, so the two commands cannot sample the fleet differently.

import { BUILD_ID_HEADER, isRole, renderThrowable } from '@ultimat3/core';

export interface ReadyzAnswer {
  /** `null`: nothing answered — refused, reset or timed out. */
  readonly status: number | null;
  /** `x-ultimate-build` as answered, on any status. `null`: no header, or an empty one. */
  readonly build: string | null;
  /** Answered from a cache (`Age` > 0): a CDN's copy says nothing about the fleet behind it. */
  readonly cached: boolean;
  /** The body's `role`, when it is one: a role's own health port says it; the web port does not. */
  readonly role: string | null;
  /** The transport's failure, rendered, when nothing answered. */
  readonly failure?: string;
}

/** A body that is not JSON, or names no role, is an answer with no role — never a failed sample. */
async function roleOf(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null || !('role' in body)) return null;
  return typeof body.role === 'string' && isRole(body.role) ? body.role : null;
}

/**
 * One `GET /readyz` on a connection of its own, so the load balancer chooses again: a kept-alive
 * socket would ask one pod the same question for the whole window. A redirect is an answer to tally,
 * never to follow: another host's `/readyz` says nothing about this origin.
 */
export async function takeSample(origin: string, limitMs: number): Promise<ReadyzAnswer> {
  try {
    const response = await fetch(`${origin}/readyz`, {
      keepalive: false,
      redirect: 'manual',
      // Past a CDN or a caching proxy: the question is the fleet, never a stored copy of it.
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(limitMs),
    });
    const header = response.headers.get(BUILD_ID_HEADER);
    const age = Number(response.headers.get('age') ?? '0');
    return {
      status: response.status,
      build: header === null || header === '' ? null : header,
      cached: Number.isNaN(age) || age > 0,
      role: await roleOf(response),
    };
  } catch (error) {
    return {
      status: null,
      build: null,
      cached: false,
      role: null,
      failure: renderThrowable(error),
    };
  }
}
