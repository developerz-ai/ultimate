// robots.txt generation. Environment-aware, and the default is the safe one:
// anything that is not explicitly production emits `Disallow: /`, because a
// preview deploy that gets indexed outranks and cannibalises the real site.

import { absoluteUrl } from './xml';

export type SeoEnvironment = 'production' | 'preview' | 'development' | 'test';

export interface RobotsGroup {
  /** One or more user agents this group applies to. */
  userAgent: string | readonly string[];
  allow?: readonly string[];
  disallow?: readonly string[];
  crawlDelay?: number;
}

export interface RobotsConfig {
  baseUrl: string;
  /** Omitted means "resolve from the environment", which defaults to preview. */
  environment?: SeoEnvironment | undefined;
  groups?: readonly RobotsGroup[];
  /** Sitemap paths or absolute URLs. Only emitted in production. */
  sitemaps?: readonly string[];
  /** Extra lines appended verbatim, e.g. a `Host:` directive. */
  extra?: readonly string[];
}

/**
 * Fail-closed: only the exact string `production` opts a deploy into indexing.
 * A typo, an unset variable, or a branch deploy all resolve to `preview`.
 */
export function resolveEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SeoEnvironment {
  const raw = env['ULTIMATE_ENV'] ?? env['NODE_ENV'];
  if (raw === 'production') return 'production';
  if (raw === 'test') return 'test';
  if (raw === 'development') return 'development';
  return 'preview';
}

export function isIndexable(environment: SeoEnvironment): boolean {
  return environment === 'production';
}

function agents(userAgent: string | readonly string[]): readonly string[] {
  return typeof userAgent === 'string' ? [userAgent] : userAgent;
}

export function buildRobots(config: RobotsConfig): string {
  const environment = config.environment ?? resolveEnvironment();
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
