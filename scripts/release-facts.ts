#!/usr/bin/env bun
// Enforce, as a gate step, that the two release-availability COUNTS this repo restates across ten
// pages are the counts the tree actually has.
//
// The gap this closes: how many packages ship is written in `CLAUDE.md`, `README.md`,
// `AGENTS.md`, `SECURITY.md`, `PUBLISHING.md`, five wiki pages and three under `docs/idea` —
// hand-copied every time, and #209 found `SECURITY.md` claiming 28 packages and a supported line
// of `1.0.x`, two majors stale. Measured while writing this: `AGENTS.md` says 27 and
// `docs/architecture/README.md` says 28, against 29 on disk.
//
// TWO NUMBERS, deliberately. `listWorkspaces()` is on disk and needs no network, so the scoped
// count and the total are derivable here; whether a version is ON THE REGISTRY, who published it
// and whether a tarball carries an attestation are not — `scripts/version-stamps.ts` draws the same
// line for the same reason, and a gate that shelled out to `npm view` would be a gate that fails on
// a plane. The commands beside those claims in `CLAUDE.md` stay the way to check them.
//
// The version itself is NOT checked here: `scripts/version-stamps.ts` already owns one stamp on one
// page, and two reporters of one condition is the duplication this repo forbids by name.
//
//   bun run scripts/release-facts.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces } from './lib/workspaces';

const SCRIPT = 'release-facts';
export const SCOPE = '@ultimat3/';

export const FACT_GLOBS: readonly string[] = ['*.md', 'wiki/**/*.md', 'docs/**/*.md'];

/**
 * `CHANGELOG.md` names every past release's count by design, and `docs/plans/` is a dated record of
 * work. Both are history: a rule that read them would demand that the past be rewritten.
 */
export const skipFactPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'CHANGELOG.md';

/** A line that pins an OLDER release names its own count — "1.0.0 shipped the 28 packages". */
const HISTORICAL = /\b\d+\.\d+\.\d+\s+(?:shipped|published|carried|went out|had)\b|\bup from\b/;

export interface CountFact {
  /** How a finding names it. */
  readonly label: string;
  /** Every count this phrasing may legitimately state. */
  readonly accepts: readonly number[];
  /** What a page writes when it states this count. */
  readonly patterns: readonly RegExp[];
  /** A word the line must also carry, when the phrasing alone is not about packages. */
  readonly requires?: RegExp;
}

/**
 * Derived from the workspace list on disk, never restated.
 *
 * Two of the three are EXACT and one is membership, and the split is the corpus talking. A page
 * writing `` 29 `@ultimat3/*` packages `` has named which set it means; a page writing "all 30
 * packages" has not — `wiki/Upgrading.md` uses it for the total and `wiki/FAQ.md` uses the same
 * words for the scoped set, and both sentences are correct English. Membership still catches the
 * failure that matters: 27 and 28 are neither, which is what `AGENTS.md` says today.
 */
export function releaseFacts(names: readonly string[]): readonly CountFact[] {
  const scoped = names.filter((name) => name.startsWith(SCOPE)).length;
  const total = names.length;
  return [
    {
      label: `\`${SCOPE}*\` packages`,
      accepts: [scoped],
      patterns: [/(\d+)\s+`?@ultimat3\/\*`?\s+packages/g],
    },
    {
      label: 'workspaces in all',
      accepts: [total],
      patterns: [
        /(\d+)\s+in all\b/g,
        /[Aa]ll\s+(\d+)\s+workspaces\b/g,
        /(\d+)\s+workspaces\s+(?:publish|resolve|move)/g,
        /(\d+)\s+tarballs\b/g,
      ],
      // `wiki/The-Eight-Primitives.md` writes "25 in all" about the FILES in a generated slice.
      requires: /packages?\b|workspaces?\b|tarballs?\b/,
    },
    {
      label: 'packages (scoped or in all)',
      accepts: [scoped, total],
      patterns: [/[Aa]ll\s+(\d+)\s+(?:packages|publish)\b/g, /(\d+)\s+packages,\s*\d+\s+tiers/g],
    },
  ];
}

export interface FactGap {
  readonly kind: 'stale' | 'vacuous';
  readonly at: string;
  readonly label: string;
  readonly claimed: number;
  readonly expected: readonly number[];
  readonly quote: string;
}

export interface FactInput {
  readonly pages: readonly MarkdownFile[];
  readonly facts: readonly CountFact[];
}

export function checkReleaseFacts(input: FactInput): readonly FactGap[] {
  const gaps: FactGap[] = [];
  let claims = 0;
  for (const page of input.pages) {
    const lines = page.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (HISTORICAL.test(line)) continue;
      for (const fact of input.facts) {
        if (fact.requires !== undefined && !fact.requires.test(line)) continue;
        for (const pattern of fact.patterns) {
          for (const match of line.matchAll(pattern)) {
            claims += 1;
            const claimed = Number.parseInt(match[1] ?? '0', 10);
            if (fact.accepts.includes(claimed)) continue;
            gaps.push({
              kind: 'stale',
              at: `${page.path}:${index + 1}`,
              label: fact.label,
              claimed,
              expected: fact.accepts,
              quote: (match[0] ?? '').trim(),
            });
          }
        }
      }
    }
  }
  if (claims === 0) {
    gaps.push({
      kind: 'vacuous',
      at: FACT_GLOBS[0] ?? '',
      label: '',
      claimed: 0,
      expected: [],
      quote: '',
    });
  }
  return gaps;
}

const staleFinding = (gap: FactGap): Finding => ({
  code: 'X_DOC_RELEASE_FACT_STALE',
  cause: `${gap.at} writes "${gap.quote}" and this tree has ${gap.expected.join(' or ')} ${gap.label}`,
  fix: `set the count at ${gap.at} to ${gap.expected.join(' or ')}; \`bun run scripts/list-workspaces.ts\` is where the number comes from`,
  at: gap.at,
});

const vacuousFinding = (): Finding => ({
  code: 'X_DOC_RELEASE_FACT_UNSCANNED',
  cause:
    'no page states a package count, so this rule read nothing and reported green over ten pages that restate one',
  fix: `check FACT_GLOBS and the patterns in scripts/${SCRIPT}.ts still match how the pages write it`,
  at: `scripts/${SCRIPT}.ts`,
});

export const releaseFactFindingFor = (gap: FactGap): Finding =>
  gap.kind === 'vacuous' ? vacuousFinding() : staleFinding(gap);

export const readFactPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of FACT_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipFactPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

export const releaseFactGaps = async (root: string): Promise<readonly FactGap[]> =>
  checkReleaseFacts({
    pages: await readFactPages(root),
    facts: releaseFacts((await listWorkspaces(root)).map((workspace) => workspace.name)),
  });

/** What this repo contributes to `x verify`'s `manifest` step. */
export const releaseFactFindings = async (root: string): Promise<readonly Finding[]> =>
  (await releaseFactGaps(root)).map(releaseFactFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const gaps = await releaseFactGaps(root);
  const facts = releaseFacts((await listWorkspaces(root)).map((workspace) => workspace.name));
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? `every stated count matches the tree (${facts.map((f) => `${f.accepts.join('/')} ${f.label}`).join(', ')})`
          : `${gaps.length} stated package count(s) no longer match the tree`,
      findings: gaps.map(releaseFactFindingFor),
    },
    args.json,
  );
}
