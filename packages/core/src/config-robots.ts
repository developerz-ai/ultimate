// Single responsibility: the refusals `seo.robots` earns — its `disallow` paths and each per-crawler
// group. Split from `config-site.ts`, which owns the shapes and the merge; this file only judges.
// `unknown` in throughout: an untyped config reaches here with whatever it wrote.

import { describeValue } from './error-render';
import { isJsonObject } from './json-object';

/** Every entry of a robots path list that is not a string starting with `/`. */
export function robotsPathIssues(label: string, paths: unknown): readonly string[] {
  if (!Array.isArray(paths))
    return [`${label} must be a list of paths, not ${describeValue(paths)}`];
  const issues: string[] = [];
  for (const path of paths as readonly unknown[]) {
    if (typeof path !== 'string') {
      issues.push(`${label} entry must be a path string, not ${describeValue(path)}`);
    } else if (!path.startsWith('/')) {
      issues.push(`${label} entry "${path}" must start with /`);
    }
  }
  return issues;
}

function userAgentIssues(label: string, userAgent: unknown): readonly string[] {
  const agents: readonly unknown[] = Array.isArray(userAgent) ? userAgent : [userAgent];
  if (agents.length === 0) return [`${label} must name at least one user agent`];
  return agents.flatMap((agent) =>
    typeof agent === 'string' && agent.trim() !== '' && !/[\r\n]/.test(agent)
      ? []
      : [
          `${label} must be a non-empty user-agent string (or a list of them), not ${describeValue(agent)}`,
        ],
  );
}

/** Every refusal `seo.robots.groups` earns, as sentences naming the group by its index. */
export function robotsGroupIssues(groups: unknown): readonly string[] {
  if (!Array.isArray(groups)) {
    return [`seo.robots.groups must be a list of groups, not ${describeValue(groups)}`];
  }
  return (groups as readonly unknown[]).flatMap((group, index) => {
    const at = `seo.robots.groups[${index}]`;
    if (!isJsonObject(group)) return [`${at} must be an object, not ${describeValue(group)}`];
    const issues = [...userAgentIssues(`${at}.userAgent`, group['userAgent'])];
    for (const key of ['allow', 'disallow'] as const) {
      if (group[key] !== undefined) issues.push(...robotsPathIssues(`${at}.${key}`, group[key]));
    }
    const delay = group['crawlDelay'];
    if (
      delay !== undefined &&
      !(typeof delay === 'number' && Number.isFinite(delay) && delay >= 0)
    ) {
      issues.push(`${at}.crawlDelay must be a number of seconds ≥ 0, not ${describeValue(delay)}`);
    }
    return issues;
  });
}
