// Which link in a set is the current page — the one rule `NavList` and `BottomNav` share. The
// longest href that is the current path or a whole-segment prefix of it wins, so `/runs/7` marks
// `/runs` and not `/`; exactly one item wins or none does, decided by position on a tie.

/** The path of an href, without its query or fragment and without a trailing slash. */
function pathOf(href: string): string {
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** `prefix` is `path` itself or an ancestor of it on a `/` boundary. */
function covers(prefix: string, path: string): boolean {
  if (prefix === path || prefix === '/') return true;
  return path.startsWith(`${prefix}/`);
}

/**
 * The index of the current item, or `-1` when no href covers `currentHref`. Two equal hrefs are a
 * tie the FIRST wins — one `aria-current` per list, never two.
 */
export function currentOf(
  items: readonly { readonly href: string }[],
  currentHref: string,
): number {
  const path = pathOf(currentHref);
  let best = -1;
  let bestLength = -1;
  items.forEach((item, index) => {
    const candidate = pathOf(item.href);
    if (covers(candidate, path) && candidate.length > bestLength) {
      best = index;
      bestLength = candidate.length;
    }
  });
  return best;
}
