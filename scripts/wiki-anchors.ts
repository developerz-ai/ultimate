#!/usr/bin/env bun
// Enforce, as a gate rule, that every `Page#anchor` and `#anchor` link on a `wiki/` page lands on
// a heading of its target page. `scripts/doc-paths.ts` proves a named FILE exists; nothing proved a
// fragment does, and a renamed heading turns every link into it into a jump to the top of a page —
// GitHub renders no error, so the reader lands somewhere else and is not told.
//
// THE SLUG IS GITHUB'S: the heading's rendered text, lowercased, every character that is not a
// letter, digit, mark, `-`, `_` or space dropped, each space a `-`, and a repeated slug numbered
// `-1`, `-2` in document order. An `<a id|name="…">` on the page is a target too. External URLs and
// relative paths out of the wiki (`../docs/…`) are not wiki pages and are not read.
//
// ZERO-PINNED: a dead anchor is a one-line edit, and a ratchet at zero is a rule.
//
//   bun run scripts/wiki-anchors.ts [--json]

import { nearestName } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'wiki-anchors';
export const WIKI_PAGE_GLOB = 'wiki/*.md';

export interface WikiPage {
  /** The page name, `Error-Codes` — the file stem, and how a wiki link names it. */
  readonly page: string;
  readonly text: string;
}

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HTML_ANCHOR = /<a\s+(?:[^>]*\s)?(?:id|name)=["']([^"']+)["']/g;
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const CODE_SPAN = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** A heading's text as GitHub renders it: links become their text, markup and tags are dropped. */
const renderedText = (heading: string): string =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replaceAll('`', '');

/** GitHub's heading slug, before the duplicate suffix. */
export const slugOf = (heading: string): string =>
  renderedText(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');

/** The lines outside fenced blocks, with their 1-based numbers. */
function proseLines(text: string): readonly { readonly line: number; readonly text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line: index + 1, text: line });
  });
  return out;
}

/** Every fragment a link may land on in `text`: heading slugs, numbered as GitHub numbers them. */
export function anchorsOf(text: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text: line } of proseLines(text)) {
    for (const match of line.matchAll(HTML_ANCHOR)) anchors.add(match[1] ?? '');
    const heading = HEADING.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slugOf(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

export interface AnchorLink {
  readonly from: string;
  readonly line: number;
  /** The page the link names — the linking page itself for a bare `#anchor`. */
  readonly page: string;
  readonly anchor: string;
}

/** The wiki-internal links with a fragment on one page, outside fences and code spans. */
export function anchorLinksOf(page: WikiPage): readonly AnchorLink[] {
  const links: AnchorLink[] = [];
  for (const { line, text } of proseLines(page.text)) {
    for (const match of text.replace(CODE_SPAN, '').matchAll(LINK)) {
      const target = match[1] ?? '';
      const hash = target.indexOf('#');
      if (hash === -1 || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const path = target.slice(0, hash).replace(/^\.\//, '').replace(/\.md$/, '');
      if (path.includes('/')) continue;
      let anchor = target.slice(hash + 1);
      try {
        anchor = decodeURIComponent(anchor);
      } catch {
        // A malformed escape is checked as written: it matches no heading, which is the finding.
      }
      links.push({ from: page.page, line, page: path === '' ? page.page : path, anchor });
    }
  }
  return links;
}

/** Every link whose page is missing or whose fragment is no target on it. Pure over the pages. */
export function deadAnchors(pages: readonly WikiPage[]): readonly AnchorLink[] {
  const targets = new Map(pages.map((page) => [page.page, anchorsOf(page.text)]));
  return pages
    .flatMap(anchorLinksOf)
    .filter((link) => targets.get(link.page)?.has(link.anchor) !== true);
}

export function deadAnchorFinding(link: AnchorLink, pages: readonly WikiPage[]): Finding {
  const at = `wiki/${link.from}.md:${link.line}`;
  const target = pages.find((page) => page.page === link.page);
  if (target === undefined) {
    return {
      code: 'X_WIKI_ANCHOR_DEAD',
      cause: `${at} links ${link.page}#${link.anchor}, and there is no wiki/${link.page}.md`,
      fix: `bun run scripts/wiki-anchors.ts --json   # then edit ${at} to name an existing wiki page`,
      at,
    };
  }
  const near = nearestName(link.anchor, [...anchorsOf(target.text)]);
  return {
    code: 'X_WIKI_ANCHOR_DEAD',
    cause: `${at} links ${link.page}#${link.anchor}, and no heading on wiki/${link.page}.md has that slug — GitHub lands the reader at the top of the page and says nothing`,
    fix:
      near === undefined
        ? `bun run scripts/wiki-anchors.ts --json   # then edit ${at} to link a heading of wiki/${link.page}.md, or restore the heading it named`
        : `bun run scripts/wiki-anchors.ts --json   # then edit ${at}: replace #${link.anchor} with #${near}`,
    at,
  };
}

const unscanned = (): Finding => ({
  code: 'X_WIKI_ANCHOR_UNSCANNED',
  cause: `no ${WIKI_PAGE_GLOB} link carried a #fragment, so this rule reported green over links it never read`,
  fix: 'bun run scripts/wiki-anchors.ts --json — run it from the repo root, where wiki/ is',
  at: 'wiki/',
});

export async function readWikiPages(root: string): Promise<readonly WikiPage[]> {
  const pages: WikiPage[] = [];
  for await (const path of new Bun.Glob(WIKI_PAGE_GLOB).scan({ cwd: root, absolute: false })) {
    const stem = (path.replaceAll('\\', '/').split('/').at(-1) ?? path).replace(/\.md$/, '');
    pages.push({ page: stem, text: await Bun.file(`${root}/${path}`).text() });
  }
  return pages.sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0));
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function wikiAnchorFindings(root: string): Promise<readonly Finding[]> {
  const pages = await readWikiPages(root);
  if (pages.flatMap(anchorLinksOf).length === 0) return [unscanned()];
  return deadAnchors(pages).map((link) => deadAnchorFinding(link, pages));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const pages = await readWikiPages(root);
  const links = pages.flatMap(anchorLinksOf);
  const findings = await wikiAnchorFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${links.length} wiki anchor link(s) across ${pages.length} pages, every one lands on a heading`
          : `${findings.length} wiki anchor link(s) land on no heading`,
      findings,
      data: { links: links.length, pages: pages.length },
    },
    args.json,
  );
}
