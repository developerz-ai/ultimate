// robots.txt, obeyed by DEFAULT, and ignorable only with a written reason.
//
// Ultimate's users are not all scraping their own accounts. `robots: 'obey'` being the default
// makes the polite thing the thing that happens when nobody decides; `robots: { ignore: reason }`
// makes the impolite thing a sentence somebody has to write, in the diff, next to their name.
// There is no boolean, because `robots: false` is a decision with no author.

import { robotsDisallowed } from './error-throws';
import type { RobotsFetchInit } from './robots-fetch';
import { robotsFetcher } from './robots-fetch';

export type RobotsPolicy = 'obey' | { readonly ignore: string };

export const DEFAULT_ROBOTS_AGENT = 'ultimate-scraper';

export interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface RobotsRules {
  readonly rules: readonly RobotsRule[];
}

/**
 * The `User-agent` groups that apply to `agent`: its own, plus `*` when the file names no group
 * for it. A file that addresses this agent specifically REPLACES the wildcard group, which is
 * what the standard says and what every operator writing a targeted rule expects.
 */
export function parseRobots(text: string, agent: string): RobotsRules {
  const wanted = agent.toLowerCase();
  const groups = new Map<string, RobotsRule[]>();
  let current: string[] = [];
  let inGroup = false;
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (inGroup) current = [];
      inGroup = false;
      current.push(value.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    inGroup = true;
    for (const name of current) {
      const rules = groups.get(name) ?? [];
      // An empty `Disallow:` is the documented spelling of "allow everything", not a rule about
      // the empty path — read as a path it would match every URL and refuse the whole site.
      if (value !== '' || field === 'allow') rules.push({ allow: field === 'allow', path: value });
      groups.set(name, rules);
    }
  }
  return { rules: groups.get(wanted) ?? groups.get('*') ?? [] };
}

/**
 * `/private/*.pdf$` — the two wildcards robots.txt defines, and no others, matched by WALKING the
 * pattern rather than by compiling one.
 *
 * The rule text is remote: robots.txt belongs to the site being scraped, and `robotsAllows` runs on
 * every navigation and every HTTP-leg request, synchronously, on the worker's only thread. A regex
 * built as `body.split('*').join('.*')` backtracks catastrophically on a non-matching path — a rule
 * with 24 wildcards did not return inside 60s, past `ctx.signal`, the watchdog and the job timeout,
 * all of which are downstream of a `return` that never happens. This walk is O(pattern × path) with
 * no backtracking beyond the LAST star, so the class is removed rather than bounded.
 */
const patternMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith('$');
  // Unanchored means "matches a PREFIX of the path", which is the same statement as a full match
  // against the pattern with one more `*` on the end — one code path instead of two.
  const body = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < path.length) {
    if (p < body.length && body[p] === '*') {
      star = p;
      p += 1;
      resume = s;
      continue;
    }
    if (p < body.length && body[p] === path[s]) {
      p += 1;
      s += 1;
      continue;
    }
    if (star === -1) return false;
    // Only the most recent star is ever retried, which is what keeps this linear per star instead
    // of exponential across all of them.
    p = star + 1;
    resume += 1;
    s = resume;
  }
  while (p < body.length && body[p] === '*') p += 1;
  return p === body.length;
};

/**
 * Longest match wins, and a tie goes to `Allow` — the rule every major crawler implements. A
 * naive "first disallow wins" reading refuses paths an operator explicitly re-allowed.
 */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let verdict = true;
  let best = -1;
  for (const rule of rules.rules) {
    if (!patternMatches(rule.path, path)) continue;
    const weight = rule.path.length;
    if (weight > best || (weight === best && rule.allow)) {
      best = weight;
      verdict = rule.allow;
    }
  }
  return verdict;
}

export interface RobotsGate {
  /** Throws `X_SCRAPE_ROBOTS_DISALLOWED`, or returns. Called before every navigation. */
  assertAllowed(url: string): Promise<void>;
  /** The reason an `ignore` gate carries, for the run's own record. `undefined` when obeying. */
  readonly ignoredBecause: string | undefined;
}

export type RobotsFetch = (robotsUrl: string) => Promise<string | undefined>;

export interface RobotsGateInit extends RobotsFetchInit {
  readonly policy: RobotsPolicy;
  readonly agent?: string | undefined;
  /** A caller-supplied read. With none, `robotsFetcher` builds the deadlined, capped default. */
  readonly fetchText?: RobotsFetch | undefined;
}

/**
 * One fetch of `/robots.txt` per ORIGIN per run, cached. A gate that re-fetched per navigation
 * would triple the request count of every scrape it protects.
 *
 * An origin whose robots.txt cannot be read is ALLOWED. That is the standard's own answer — a
 * missing file means no restrictions — and the alternative fails every run behind a flaky CDN.
 */
export function createRobotsGate(init: RobotsGateInit): RobotsGate {
  if (init.policy !== 'obey') {
    return { assertAllowed: () => Promise.resolve(), ignoredBecause: init.policy.ignore };
  }
  const agent = init.agent ?? DEFAULT_ROBOTS_AGENT;
  const read = init.fetchText ?? robotsFetcher(init);
  const cache = new Map<string, Promise<RobotsRules>>();
  return {
    ignoredBecause: undefined,
    async assertAllowed(url: string): Promise<void> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      const origin = parsed.origin;
      let rules = cache.get(origin);
      if (rules === undefined) {
        rules = read(`${origin}/robots.txt`)
          .then((text) => (text === undefined ? { rules: [] } : parseRobots(text, agent)))
          .catch(() => ({ rules: [] }));
        cache.set(origin, rules);
      }
      if (!robotsAllows(await rules, `${parsed.pathname}${parsed.search}`)) {
        throw robotsDisallowed(url, agent);
      }
    },
  };
}
