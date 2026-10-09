// One answer to "does this path pass through a directory called X". Six modules asked it with
// `path.includes('node_modules')`, which is a SUBSTRING match: an app checked out under
// `~/dev/node_modules-experiments/myapp` answered true for every file it holds, so `loadApp`
// imported none of them and the app registered nothing at all.

/** Split on either separator: a rule that reads `a/b` and not `a\b` does not exist on Windows. */
export function pathSegments(path: string): readonly string[] {
  return path.replaceAll('\\', '/').split('/');
}

/** Whether any whole segment of `path` is `segment` — never a substring of one. */
export function hasPathSegment(path: string, segment: string): boolean {
  return pathSegments(path).includes(segment);
}

/**
 * Whether `path` lies strictly below `root`, on either separator. Bun resolves paths with a
 * backslash on Windows, so `path.startsWith(`${root}/`)` was false for every file there: the dev
 * reload graph recorded no import and no sheet as the app's own, and a save rendered stale code.
 */
export function isPathUnder(root: string, path: string): boolean {
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return path.replaceAll('\\', '/').startsWith(`${base}/`);
}
