// How an `over` gap SAYS its sites: every one, the ones new since `origin/main` first. A package's
// first site is usually one its pin already allows, so a finding naming only that sent its reader
// to a line that was never the problem. Which sites are new is read from the base ref when the
// checkout has one — read-only, never fetched — and the plain list is the answer when it has none.

import type { GitRunner } from './base-ref';
import { BASE_REF, textAt } from './base-ref';
import type { RatchetGap } from './ratchet';
import { run } from './run';

/** Sites a cause spells out. A package pinned at 90 is over by one, and 91 paths is not a sentence. */
export const SITE_LIST_MAX = 12;

/** What a guard supplies so its sites can be told apart from the base's: its scanner, per file. */
export interface SiteProbe<S> {
  /** The guard's own single-file scan — what it reports for `source` read as `path`. */
  readonly rescan: (path: string, source: string) => readonly S[];
  /** The 1-based line a site is on. */
  readonly line: (site: S) => number;
}

const sitesOf = <S>(gap: RatchetGap<S>): readonly S[] =>
  gap.sites ?? (gap.first === undefined ? [] : [gap.first]);

/** The site a finding's `at:` names: the first NEW one when that is known, else the first. */
export const leadSite = <S>(gap: RatchetGap<S>): S | undefined => sitesOf(gap)[0];

/**
 * The sites as a cause lists them, capped at `SITE_LIST_MAX`. `explain` is the command that prints
 * the rest, named only when the list was cut — a guard with no such flag passes none.
 */
export function siteList<S>(
  gap: RatchetGap<S>,
  render: (site: S) => string,
  explain?: string,
): string {
  const sites = sitesOf(gap);
  const shown = sites.slice(0, SITE_LIST_MAX).map(render);
  const cut = sites.length - shown.length;
  const more =
    cut === 0 ? '' : ` … and ${String(cut)} more${explain === undefined ? '' : ` (${explain})`}`;
  const fresh = Math.min(gap.fresh ?? 0, shown.length);
  if (fresh === 0) return `${shown.join(', ')}${more}`;
  const old = shown.slice(fresh);
  const already = old.length === 0 ? '' : `; already there: ${old.join(', ')}`;
  return `new since ${BASE_REF}: ${shown.slice(0, fresh).join(', ')}${already}${more}`;
}

/** Where a fix points: the one site, the new ones when they are known, else "whichever was added". */
export function siteTarget<S>(gap: RatchetGap<S>, at: (site: S) => string): string {
  const sites = sitesOf(gap);
  const [only] = sites;
  if (only !== undefined && (sites.length === 1 || gap.fresh === 1)) return at(only);
  if ((gap.fresh ?? 0) > 1) return `the ${String(gap.fresh)} sites the cause lists as new`;
  // Nothing is pinned, so nothing is excused: every site is the finding.
  if (gap.pinned === 0) return `each of the ${String(sites.length)} sites the cause lists`;
  return `${String(gap.found - gap.pinned)} of the ${String(sites.length)} sites the cause lists — whichever this change added`;
}

const lineText = (source: string, line: number): string =>
  (source.split('\n')[line - 1] ?? '').trim();

/**
 * Each `over` gap with its NEW sites moved to the front and counted in `fresh`. A site is new when
 * the text of its line is not the line of a site the same scanner finds in the file at `BASE_REF`
 * — the text, never the line number, so an edit above an old site does not make it read as new.
 *
 * Costs nothing on a green tree: a gap with a zero pin is new in full and is left alone, and only
 * the files of a gap over a real pin are read, one `git show` each. No `BASE_REF` in the checkout
 * (a tag checkout, a fresh shallow clone) returns the gaps as given: unordered, and still complete.
 */
export async function newSitesFirst<S extends { readonly path: string }>(
  root: string,
  gaps: readonly RatchetGap<S>[],
  probe: SiteProbe<S>,
  git: GitRunner = run,
): Promise<readonly RatchetGap<S>[]> {
  const probed = (gap: RatchetGap<S>): boolean =>
    gap.kind === 'over' && gap.pinned > 0 && gap.sites !== undefined;
  if (!gaps.some(probed)) return gaps;
  const has = await git(['git', 'rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], {
    cwd: root,
  });
  if (!has.ok) return gaps;
  const ordered: RatchetGap<S>[] = [];
  for (const gap of gaps) {
    if (!probed(gap)) {
      ordered.push(gap);
      continue;
    }
    const sites = gap.sites ?? [];
    const fresh: S[] = [];
    const old: S[] = [];
    for (const path of new Set(sites.map((site) => site.path))) {
      const now = await Bun.file(`${root}/${path}`).text();
      const then = await textAt(root, BASE_REF, path, git);
      // A multiset: two identical lines at the base excuse two here, and a third is new.
      const held = new Map<string, number>();
      for (const site of then === undefined ? [] : probe.rescan(path, then)) {
        const key = lineText(then ?? '', probe.line(site));
        held.set(key, (held.get(key) ?? 0) + 1);
      }
      for (const site of sites) {
        if (site.path !== path) continue;
        const key = lineText(now, probe.line(site));
        const left = held.get(key) ?? 0;
        if (left === 0) fresh.push(site);
        else {
          held.set(key, left - 1);
          old.push(site);
        }
      }
    }
    ordered.push({ ...gap, sites: [...fresh, ...old], fresh: fresh.length });
  }
  return ordered;
}
