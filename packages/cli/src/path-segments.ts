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
