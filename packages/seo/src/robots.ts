// robots.txt generation. Environment-aware, and the default is the safe one:
// anything that is not explicitly production emits `Disallow: /`, because a
// branch deploy that gets indexed outranks and cannibalises the real site.

import { DEFAULT_ENVIRONMENT, type Environment, tryResolveEnvironment } from '@ultimat3/core';
import { absoluteUrl } from './xml';

export interface RobotsGroup {
  /** One or more user agents this group applies to. */
  userAgent: string | readonly string[];
  allow?: readonly string[];
  disallow?: readonly string[];
  crawlDelay?: number;
}

export interface RobotsConfig {
  baseUrl: string;
  /** Omitted means "resolve from the environment"; anything but `production` disallows all. */
  environment?: Environment | undefined;
  groups?: readonly RobotsGroup[];
  /** Sitemap paths or absolute URLs. Only emitted in production. */
  sitemaps?: readonly string[];
  /** Extra lines appended verbatim, e.g. a `Host:` directive. */
  extra?: readonly string[];
}

/**
 * Fail-closed: only the exact string `production` opts a deploy into indexing. A branch deploy
 * (`staging`), a laptop, a typo and an unset variable are all "not production" and all disallow.
 */
export function isIndexable(environment: Environment): boolean {
  return environment === 'production';
}

/**
 * `@ultimat3/core` owns the read of `ULTIMATE_ENV`; this module owns only what an unreadable one
 * means for a crawler. A typo in that key throws there, and a `robots.txt` render can be the first
 * thing in a web process to ask — nothing in the container's boot path resolves the environment
 * unconditionally — so an unnameable deploy resolves to core's own default here. The body was
 * already going to be `Disallow: /`; a 500 would only cost the operator the reason.
 */
function ambientEnvironment(): Environment {
  return tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT;
}

function agents(userAgent: string | readonly string[]): readonly string[] {
  return typeof userAgent === 'string' ? [userAgent] : userAgent;
}

export function buildRobots(config: RobotsConfig): string {
  const environment = config.environment ?? ambientEnvironment();
  const lines: string[] = [`# environment: ${environment}`];

  if (!isIndexable(environment)) {
    // No sitemap either: advertising one invites a crawl we just refused.
    lines.push('User-agent: *', 'Disallow: /');
    return `${lines.join('\n')}\n`;
  }

  const groups: readonly RobotsGroup[] =
    config.groups === undefined || config.groups.length === 0
      ? [{ userAgent: '*', allow: ['/'] }]
      : config.groups;

  for (const group of groups) {
    for (const agent of agents(group.userAgent)) lines.push(`User-agent: ${agent}`);
    for (const path of group.allow ?? []) lines.push(`Allow: ${path}`);
    for (const path of group.disallow ?? []) lines.push(`Disallow: ${path}`);
    if (group.crawlDelay !== undefined) lines.push(`Crawl-delay: ${group.crawlDelay}`);
    lines.push('');
  }

  for (const sitemap of config.sitemaps ?? ['/sitemap.xml']) {
    lines.push(`Sitemap: ${absoluteUrl(config.baseUrl, sitemap)}`);
  }
  for (const line of config.extra ?? []) lines.push(line);

  return `${lines.join('\n').trimEnd()}\n`;
}
