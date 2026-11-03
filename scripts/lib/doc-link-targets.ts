// Single responsibility: the `](target)` links on a line of a page, and the repo path each one
// lands its reader on — for `doc-paths`, which held backticked paths to existence and let a dead
// markdown link through (the one dead link in 1,688, found by hand on 2026-11-02, was one).

const LINK = /\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const CODE_SPAN = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PLACEHOLDER = /[*?<>{}$…]|\.\.\.(?!\/)/;

/** Every inline link and image target on one line of prose, outside its code spans. */
export const linkTargetsIn = (line: string): readonly string[] =>
  [...line.replace(CODE_SPAN, '').matchAll(LINK)].map((match) => match[1] ?? match[2] ?? '');

/** `a/./b/../c` as `a/c`; `undefined` when the path climbs above the repository root. */
function normalize(segments: readonly string[]): string | undefined {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * The repo path `target` names from the page at `from`, or `undefined` when it names no file in
 * this tree: a URL, a fragment of the same page, a placeholder, or a path above the root. A bare
 * name on a `wiki/` page (`Error-Codes`, `_Footer`) is the wiki page GitHub renders it as.
 */
export function resolveLinkTarget(from: string, target: string): string | undefined {
  const path = target.replace(/[#?].*$/, '');
  if (path === '' || SCHEME.test(target) || PLACEHOLDER.test(path)) return undefined;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is checked as written: it names no file, which is the finding.
  }
  const dir = from.split('/').slice(0, -1);
  if (dir[0] === 'wiki' && dir.length === 1 && !decoded.includes('/') && !decoded.includes('.')) {
    return `wiki/${decoded}.md`;
  }
  const resolved = decoded.startsWith('/')
    ? normalize(decoded.split('/'))
    : normalize([...dir, ...decoded.split('/')]);
  return resolved === '' ? undefined : resolved;
}
