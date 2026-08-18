// robots.txt, obeyed by DEFAULT, and ignorable only with a written reason.
//
// Ultimate's users are not all scraping their own accounts. `robots: 'obey'` being the default
// makes the polite thing the thing that happens when nobody decides; `robots: { ignore: reason }`
// makes the impolite thing a sentence somebody has to write, in the diff, next to their name.
// There is no boolean, because `robots: false` is a decision with no author.

import { robotsDisallowed } from './error-throws';

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

const escaped = (literal: string): string => literal.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/private/*.pdf$` — the two wildcards robots.txt defines, and no others. */
const patternMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(escaped).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
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

const fetchRobots: RobotsFetch = async (robotsUrl) => {
  const response = await fetch(robotsUrl);
  return response.ok ? await response.text() : undefined;
};

export interface RobotsGateInit {
  readonly policy: RobotsPolicy;
  readonly agent?: string | undefined;
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
  const read = init.fetchText ?? fetchRobots;
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
