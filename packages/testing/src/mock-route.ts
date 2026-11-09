// What `mockFetch` registers and whether a call reaches it: the verb a match spells, the answers a
// list gives in order, and the name a pinned dial carries. `sealed-network.ts` owns when it is asked.

import { assert, peerAddressClass } from '@ultimat3/core';

export type MockHandler = (request: Request) => Response | Promise<Response>;

export interface MockRoute {
  /** Exact URL, or a prefix ending in `*`, or a RegExp. */
  readonly match: string | RegExp;
  /** The one verb answered, uppercase. Absent answers every verb. */
  readonly method?: string;
  readonly handler: MockHandler;
}

/** `POST https://…`, the spelling `x shot` states use. A URL holds no space, so nothing else fits. */
const VERB_PREFIX = /^([A-Z]+) (.+)$/;

/** One handler over a list: the last answer repeats, and a clone means a repeat still has a body. */
const inOrder = (match: string | RegExp, answers: readonly (Response | Error)[]): MockHandler => {
  const spelled = typeof match === 'string' ? `'${match}'` : String(match);
  assert(
    answers.length > 0,
    `mockFetch(${spelled}) was handed an empty answer list, so no call could be answered`,
    `mockFetch(${spelled}, [new Response('{}')]) — one answer at least`,
  );
  const pending = [...answers];
  return () => {
    const answer = pending.length > 1 ? pending.shift() : pending[0];
    if (answer instanceof Error) throw answer;
    return (answer as Response).clone();
  };
};

export function mockRoute(
  match: string | RegExp,
  answer: MockHandler | readonly (Response | Error)[],
): MockRoute {
  const handler = typeof answer === 'function' ? answer : inOrder(match, answer);
  const verb = typeof match === 'string' ? VERB_PREFIX.exec(match) : null;
  if (verb?.[1] === undefined || verb[2] === undefined) return { match, handler };
  return { match: verb[2], method: verb[1], handler };
}

const urlMatches = (match: string | RegExp, url: string): boolean => {
  if (match instanceof RegExp) {
    // A `g`/`y` pattern's `test` resumes at `lastIndex`: without the reset, every other call missed.
    match.lastIndex = 0;
    return match.test(url);
  }
  if (match.endsWith('*')) return url.startsWith(match.slice(0, -1));
  return match === url;
};

/**
 * A pinned dial is an address literal carrying the name it stands for in `host`, so a mock of the
 * name is the mock of that dial. Only a literal: a named URL's host header names nothing it dials.
 */
const namedUrl = (url: string, headers: Readonly<Record<string, string>>): string | undefined => {
  const host = headers['host'];
  if (host === undefined || !URL.canParse(url)) return undefined;
  const named = new URL(url);
  if (peerAddressClass(named.hostname) === undefined) return undefined;
  named.host = host;
  return named.href;
};

/** Whether `route` answers this call. */
export const routeMatches = (
  route: MockRoute,
  call: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  },
): boolean => {
  if (route.method !== undefined && route.method !== call.method) return false;
  if (urlMatches(route.match, call.url)) return true;
  const named = namedUrl(call.url, call.headers);
  return named !== undefined && urlMatches(route.match, named);
};

/** A RegExp's literal text: a `.` in a host is `\.` in its source. */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Whether `route` answers some URL on `hostname` — what makes the sealed resolver answer the name.
 * A string names its host outright; a RegExp when it matches the host's origin or spells the host
 * in its source (`/api\.vendor\.example\/v1/`), since no reader can enumerate what a pattern matches.
 */
export const routeNamesHost = (route: MockRoute, hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (route.match instanceof RegExp) {
    const pattern = route.match;
    const origins = [`https://${host}/`, `http://${host}/`];
    if (origins.some((origin) => urlMatches(pattern, origin))) return true;
    const source = pattern.source.toLowerCase();
    return source.includes(escaped(host)) || source.includes(host);
  }
  const literal = route.match.endsWith('*') ? route.match.slice(0, -1) : route.match;
  return URL.canParse(literal) && new URL(literal).hostname.toLowerCase() === host;
};
