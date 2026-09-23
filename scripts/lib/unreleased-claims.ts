// A page that calls a version "unreleased" after `CHANGELOG.md` dated it. `21.0.0, unreleased`
// was true on 2026-09-22 and false the next day, and nothing re-read the ~40 lines that said it —
// so the docs told an agent the installable version did not have what it had. One rule, read off
// the changelog's own dated headings, so it goes stale exactly when the release happens.

import { UNRELEASED_CLAIM_PINS, UNRELEASED_PINS_FILE } from './unreleased-claim-pins';

/** The pages a reader treats as current. `docs/plans/` is a dated record and is not one. */
export const CLAIM_SURFACES = [
  '*.md',
  'llms.txt',
  'docs/**/*.md',
  'wiki/**/*.md',
  'packages/*/*.md',
  'examples/*/*.md',
  'dummy/*/*.md',
] as const;
const NOT_CURRENT = /^(?:docs\/plans\/|CHANGELOG\.md$)/;

/** Every version whose `## X.Y.Z - YYYY-MM-DD` heading carries a date: it has shipped. */
export function datedVersions(changelog: string): ReadonlySet<string> {
  const dated = new Set<string>();
  for (const match of changelog.matchAll(
    /^## \[?(\d+\.\d+\.\d+)\]?\s*[-—]\s*\d{4}-\d{2}-\d{2}/gm,
  )) {
    if (match[1] !== undefined) dated.add(match[1]);
  }
  return dated;
}

// "unreleased" with a version inside the 40 characters either side of it — across a line break,
// because prose wraps at 100 columns — but never the changelog's own `[Unreleased]` heading name,
// which is a place, not a claim.
const WORD = /(?<![[\w])unreleased\b/gi;
const VERSION = /\d+\.\d+\.\d+/g;
const WINDOW = 40;

export interface UnreleasedClaim {
  readonly path: string;
  readonly line: number;
  readonly version: string;
}

export function unreleasedClaims(
  path: string,
  text: string,
  dated: ReadonlySet<string>,
): readonly UnreleasedClaim[] {
  const claims: UnreleasedClaim[] = [];
  for (const word of text.matchAll(WORD)) {
    const at = word.index;
    const from = Math.max(0, at - WINDOW);
    const near = text.slice(from, at + word[0].length + WINDOW);
    // The NEAREST version is the one being called unreleased: `beside 21.0.0\n22.0.0 (unreleased)`
    // is a claim about 22.0.0, whatever else the window holds.
    const distance = (match: RegExpExecArray | RegExpMatchArray): number =>
      Math.abs(from + (match.index ?? 0) - at);
    const nearest = [...near.matchAll(VERSION)].sort((a, b) => distance(a) - distance(b))[0];
    const version = nearest?.[0];
    if (version === undefined || !dated.has(version)) continue;
    const line = text.slice(0, at).split('\n').length;
    if (claims.at(-1)?.line !== line) claims.push({ path, line, version });
  }
  return claims;
}

export interface ClaimGap {
  readonly code: 'X_DOC_UNRELEASED_STALE' | 'X_DOC_UNRELEASED_PIN_STALE';
  readonly cause: string;
  readonly fix: string;
  readonly at: string;
}

/** Over its pin is a new stale line; under it is a pin nobody lowered. Both fail. */
export function claimGaps(
  claims: readonly UnreleasedClaim[],
  pins: Readonly<Record<string, number>> = UNRELEASED_CLAIM_PINS,
): readonly ClaimGap[] {
  const byPath = new Map<string, UnreleasedClaim[]>();
  for (const claim of claims) byPath.set(claim.path, [...(byPath.get(claim.path) ?? []), claim]);
  const gaps: ClaimGap[] = [];
  for (const path of new Set([...byPath.keys(), ...Object.keys(pins)])) {
    const found = byPath.get(path) ?? [];
    const pinned = Object.hasOwn(pins, path) ? (pins[path] ?? 0) : 0;
    const first = found[0];
    if (found.length > pinned && first !== undefined) {
      gaps.push({
        code: 'X_DOC_UNRELEASED_STALE',
        cause: `${path}:${first.line} calls ${first.version} unreleased, and CHANGELOG.md dates ${first.version} — ${found.length} such line(s) here, pinned at ${pinned}`,
        fix: `edit ${path}:${first.line} — drop "unreleased" (or name the version that is), then rerun: bun run changelog-check`,
        at: `${path}:${first.line}`,
      });
    } else if (found.length < pinned) {
      gaps.push({
        code: 'X_DOC_UNRELEASED_PIN_STALE',
        cause: `${path} has ${found.length} stale "unreleased" line(s) and ${UNRELEASED_PINS_FILE} still allows ${pinned}`,
        fix: `edit ${UNRELEASED_PINS_FILE} — set the row for ${path} to ${found.length}, or delete it at 0`,
        at: UNRELEASED_PINS_FILE,
      });
    }
  }
  return gaps;
}

/** The claims on every current page of the tree. */
export async function treeClaims(root: string, changelog: string): Promise<UnreleasedClaim[]> {
  const dated = datedVersions(changelog);
  const paths = new Set<string>();
  for (const pattern of CLAIM_SURFACES) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      if (!NOT_CURRENT.test(path) && !path.includes('node_modules/')) paths.add(path);
    }
  }
  const claims: UnreleasedClaim[] = [];
  for (const path of [...paths].sort()) {
    claims.push(...unreleasedClaims(path, await Bun.file(`${root}/${path}`).text(), dated));
  }
  return claims;
}
