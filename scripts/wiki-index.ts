#!/usr/bin/env bun
// Enforce, as a gate step, that `wiki/Knowledge-Base.md` registers every wiki page the repo ships
// AND that the slugs it lists actually exist on disk. The same shape as `wiki-frames.ts` and
// `wiki-tables.ts`: a committed page that claims to be a retrieval index for agents must still be
// one, and the only way to keep that promise across a growing wiki is to fail the gate when the
// promise breaks.
//
// THE RULE, TWO DIRECTIONS:
//   disk → page  every `wiki/*.md` (excluding `_Footer.md` and `_Sidebar.md`) appears in the
//                **By topic** section of `wiki/Knowledge-Base.md`. A page that exists on disk but
//                is missing from the index is a page no agent can retrieve by topic — the index
//                promised coverage, and an unindexed page is a covert withdrawal of that promise.
//   page → disk  every path listed in the **Every page, by path** table resolves to a real file.
//                A path that no longer exists is a path an agent will chase to a 404.
//
// WHY NOT INCLUDE THE PLATFORM KNOWLEDGE-BASE SLUGS IN THE GATE? The slugs the **The agent
// knowledge base** section lists are the ones the platform's `code.recall` answers for this repo;
// the platform is the source of truth for what exists, and asserting "this slug resolves" from
// the script would couple a CI job to the platform's HTTP surface. The right home for that
// assertion is a job the platform owns.
//
//   bun run scripts/wiki-index.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { type MarkdownFile, readWiki } from './wiki-tables';

/** The page the gate is built against. One source of truth for the retrieval index. */
export const KNOWLEDGE_BASE_PAGE = 'wiki/Knowledge-Base.md';

/** `wiki/` partials rendered on every GitHub wiki page; never retrieved on their own. */
const PARTIAL_FILES: ReadonlySet<string> = new Set(['wiki/_Footer.md', 'wiki/_Sidebar.md']);

/**
 * Why an index entry drifted from the file set. Two shapes: the page exists but the index lost
 * it (`unindexed`), and the index names a path that no longer exists (`ghost`). The fix differs
 * and the gate's reader must know which it is reading.
 */
export type WikiIndexGapKind = 'unindexed' | 'ghost' | 'absent';

/** The first `##` heading in `wiki/Knowledge-Base.md` — the place the **By topic** section starts. */
export const TOPIC_SECTION_HEADING = /^##\s+By topic\b/m;
/** The first `##` heading of the **Every page, by path** section. */
export const PATH_SECTION_HEADING = /^##\s+Every page, by path\b/m;

export interface WikiIndexInput {
  /** Every file under `wiki/` that is NOT a partial. */
  readonly pages: readonly MarkdownFile[];
  /** The text of `wiki/Knowledge-Base.md`, or `undefined` when the page itself is missing. */
  readonly indexPage: string | undefined;
}

/** Slug → `wiki/<slug>.md`. Pure. */
export const slugFromPath = (path: string): string | undefined => {
  if (!path.startsWith('wiki/') || !path.endsWith('.md')) return undefined;
  return path.slice('wiki/'.length, -'.md'.length);
};

/**
 * Every slug the **By topic** section lists in its tables. The format is a markdown link of the
 * form `[<label>](<slug>)` (no `.md`, no URL prefix) — the same shape `_Sidebar.md` and `Home.md`
 * already use to cross-reference wiki pages.
 */
const TOPIC_LINK = /\]\(([A-Za-z][A-Za-z0-9._-]*)\)/g;

/**
 * Every path the **Every page, by path** table lists. The format is a backtick-quoted `wiki/<x>.md`,
 * one per row. The backticks matter: a stray `(wiki/Foo)` in a sentence without backticks would
 * otherwise look identical to a table row, and a rule that reads prose as a table is a rule that
 * fails on every descriptive paragraph.
 */
const PATH_ROW = /`wiki\/([A-Za-z0-9._/-]+\.md)`/g;

export function checkWikiIndex(
  input: WikiIndexInput,
): readonly { kind: WikiIndexGapKind; page: string }[] {
  const { pages, indexPage } = input;
  if (indexPage === undefined) {
    // No index at all: every page is unindexed. One finding per page would bury the fact; the page
    // is gone, the repair is one edit, and the gate reader needs to see "the page is gone" before
    // they see "every one of 47 files is missing from it".
    return pages.length === 0 ? [] : [{ kind: 'absent', page: '' }];
  }
  const knownSlugs = new Set<string>();
  for (const file of pages) {
    const slug = slugFromPath(file.path);
    if (slug !== undefined) knownSlugs.add(slug);
  }

  const topicMatch = indexPage.match(TOPIC_SECTION_HEADING);
  const pathMatch = indexPage.match(PATH_SECTION_HEADING);
  const topicStart = topicMatch?.index ?? -1;
  // The topic section runs from its own heading to the next `##` heading (or to the path section
  // when no other heading has appeared yet). Sectioning on `##` mirrors the page's own structure.
  const topicEnd = (() => {
    if (topicStart < 0) return -1;
    const rest = indexPage.slice(topicStart + 1);
    const next = rest.match(/\n##\s/);
    return next ? topicStart + 1 + (next.index ?? 0) : indexPage.length;
  })();

  const indexedSlugs = new Set<string>();
  if (topicStart >= 0) {
    const topicSection = indexPage.slice(topicStart, topicEnd);
    for (const match of topicSection.matchAll(TOPIC_LINK)) {
      const slug = match[1] ?? '';
      // Drop the table-header anchor the index itself uses (`[Topic](Topic)`) and any URL the
      // section happens to mention — neither resolves to a wiki slug.
      if (slug.includes('/') || slug.includes('.')) continue;
      indexedSlugs.add(slug);
    }
  }

  const pathSlugs = new Set<string>();
  // `pathMatch` is the structural question — does the page even HAVE the **Every page, by path**
  // section? A page without it is silently passing on the path-direction rule because there is
  // nothing to compare against; the rule's job is to make that omission loud.
  if (pathMatch) {
    for (const match of indexPage.matchAll(PATH_ROW)) {
      const file = `wiki/${match[1] ?? ''}`;
      pathSlugs.add(file);
    }
  }

  const gaps: { kind: WikiIndexGapKind; page: string }[] = [];
  for (const file of pages) {
    const slug = slugFromPath(file.path);
    if (slug === undefined) continue;
    if (PARTIAL_FILES.has(file.path)) continue;
    // The index page itself is, by construction, the table that lists the other pages — it
    // references them, it does not register itself as one of them. A `wiki/Knowledge-Base.md`
    // that lists its own slug in its own **By topic** section would be a self-link, not a
    // useful retrieval entry, and the gate should not flag the absence as a missing page.
    if (file.path === KNOWLEDGE_BASE_PAGE) continue;
    // Partials never appear in the topic section by design; this guard is here so a future
    // author who adds a `wiki/_NewPartial.md` does not get a false finding on day one.
    if (!indexedSlugs.has(slug)) gaps.push({ kind: 'unindexed', page: file.path });
  }
  for (const file of pathSlugs) {
    if (!pages.some((page) => page.path === file)) gaps.push({ kind: 'ghost', page: file });
  }
  return gaps;
}

const absentFinding = (): Finding => ({
  code: 'X_KNOWLEDGE_BASE_PAGE_MISSING',
  cause: `${KNOWLEDGE_BASE_PAGE} does not exist, so the agent retrieval index is missing and every wiki page is unindexed`,
  fix: `restore ${KNOWLEDGE_BASE_PAGE} (git checkout -- ${KNOWLEDGE_BASE_PAGE}), or move the page and update KNOWLEDGE_BASE_PAGE in scripts/wiki-index.ts to where it went`,
  at: KNOWLEDGE_BASE_PAGE,
});

const unindexedFinding = (page: string): Finding => ({
  code: 'X_KNOWLEDGE_BASE_PAGE_MISSING',
  cause: `${page} exists on disk but ${KNOWLEDGE_BASE_PAGE} does not register it in the **By topic** section, so an agent retrieving by topic will not find it`,
  fix: `add a row for ${page} to the **By topic** section of ${KNOWLEDGE_BASE_PAGE}, then bun run scripts/wiki-index.ts --json`,
  at: page,
});

const ghostFinding = (page: string): Finding => ({
  code: 'X_KNOWLEDGE_BASE_SLUG_STALE',
  cause: `${KNOWLEDGE_BASE_PAGE} lists \`${page}\` in the **Every page, by path** table but the file does not exist on disk, so an agent retrieving that slug will read nothing`,
  fix: `delete the \`${page}\` row from ${KNOWLEDGE_BASE_PAGE}, or restore the file`,
  at: page,
});

const FINDINGS: Readonly<Record<WikiIndexGapKind, (page: string) => Finding>> = {
  unindexed: unindexedFinding,
  ghost: ghostFinding,
  absent: absentFinding,
};

export const wikiIndexFindingFor = (gap: { kind: WikiIndexGapKind; page: string }): Finding =>
  FINDINGS[gap.kind](gap.page);

/**
 * Read the wiki and the index, then check them. The one impure step.
 *
 * ABSENCE IS A FINDING HERE, gated on the wiki actually being in this tree. A script run from a
 * synthetic root in `scripts/verify.test.ts` ships neither, so it is silent for a reason rather
 * than by exemption — the same pattern `wiki-frames.ts` uses for `FRAME_KINDS`.
 */
export async function wikiIndexGaps(
  root: string,
): Promise<readonly { kind: WikiIndexGapKind; page: string }[]> {
  const indexFile = Bun.file(`${root}/${KNOWLEDGE_BASE_PAGE}`);
  const indexPage = (await indexFile.exists()) ? await indexFile.text() : undefined;
  return checkWikiIndex({ pages: await readWiki(root), indexPage });
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const wikiIndexFindings = async (root: string): Promise<readonly Finding[]> =>
  (await wikiIndexGaps(root)).map(wikiIndexFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await wikiIndexGaps(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: 'wiki-index',
      summary:
        gaps.length === 0
          ? `${KNOWLEDGE_BASE_PAGE} registers every wiki page, and every path it names exists`
          : `${gaps.length} gap(s) between ${KNOWLEDGE_BASE_PAGE} and the wiki it indexes`,
      findings: gaps.map(wikiIndexFindingFor),
    },
    args.json,
  );
}
