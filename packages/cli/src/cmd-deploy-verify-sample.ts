// One `GET /readyz` against an origin, as `x deploy verify` and `x status` both read it: a fresh
// connection, uncached, a redirect tallied rather than followed — the status, the build header, the
// role a health port names. One reader, so the two commands cannot sample the fleet differently.

import { BUILD_ID_HEADER, isRole, readWithinLimit, renderThrowable } from '@ultimat3/core';

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

/** A `/readyz` body is a few dozen bytes; past this it is not parsed, and the role is unknown. */
const READYZ_BODY_LIMIT = 4_096;

/** The most of a build id a printed line carries; the rest is cut and marked `…`. */
const PRINTED_BUILD_MAX = 128;

/**
 * A build id as it may be PRINTED — never as it is MATCHED. The origin is a stranger: a header
 * carrying `\x9b` (CSI) or `\x1b` rewrites the terminal `x status` prints to, and JSON leaves a C1
 * control unescaped. Every character outside visible ASCII and space is written `\uXXXX`, and the
 * result is cut at 128 characters, so a legal id (`release 31.27.0`) prints as itself.
 */
export const printableBuild = (value: string): string => {
  const escaped = value.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return escaped.length > PRINTED_BUILD_MAX ? `${escaped.slice(0, PRINTED_BUILD_MAX)}…` : escaped;
};

/** A body that is not JSON, or names no role, is an answer with no role — never a failed sample. */
async function roleOf(response: Response): Promise<string | null> {
  const read = await readWithinLimit(response.body, READYZ_BODY_LIMIT).catch(() => undefined);
  if (read === undefined || !('bytes' in read)) return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return null;
  }
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
      // As sent: `x deploy verify` matches it against `--build`. Printing screens it, not this.
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
