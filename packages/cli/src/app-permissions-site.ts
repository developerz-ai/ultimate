// Single responsibility: a declaration site — a stack FRAME `@ultimat3/policy` recorded for a
// `defineRoles()` or `definePermissions()` call — reduced to the file it names, absolute or
// app-root-relative. Both `policy` step questions key their findings by it.

// why: Bun ships no path API, and `relative` is what turns a stack frame's absolute path into
// the app-root-relative one every finding is keyed by.
import { relative } from 'node:path';

/** The absolute source path a frame (`at foo (/abs/path.ts:3:1)`) names, or `undefined`. */
export function frameFile(site: string): string | undefined {
  return /\(?(\/[^():]+\.[cm]?tsx?)(?::\d+)?(?::\d+)?\)?/.exec(site)?.[1];
}

/**
 * The frame's file relative to the app root, or `undefined` outside it: a locator nobody can act on
 * is worse than none. The frame is the only place the declaring module's name exists by the time
 * the declaration runs.
 */
export function siteFile(root: string, site: string): string | undefined {
  const absolute = frameFile(site);
  if (absolute === undefined) return undefined;
  const rel = relative(root, absolute).replaceAll('\\', '/');
  return rel.startsWith('..') || rel.length === 0 ? undefined : rel;
}
