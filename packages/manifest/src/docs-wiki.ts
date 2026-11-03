// The wiki pages the CLI tarball ships, as doc entries: one per heading, topic `wiki.<Page>#<anchor>`
// with GitHub's own anchor, so a topic `x docs` prints is the fragment of the page's public URL.
// Read-only, like `docs-scan.ts`; `wikiSection` is pure and answers a topic with its whole section.

// why: Bun has no directory listing and no path module (see `docs-scan.ts`).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocEntry } from './docs-scan';
import { clampDocText, isFence } from './docs-scan';

/** Who the pages ship in, so a hit names a file the install really has. */
export interface WikiOrigin {
  readonly package: string;
  readonly version: string;
  /**
   * The pages' directory relative to that package, so `source` is a path an agent can open:
   * `wiki` in an install, where the tarball carries them; `../../wiki` in this repository's checkout.
   */
  readonly dir?: string;
}

export interface WikiHeading {
  readonly level: number;
  readonly heading: string;
  /** GitHub's slug, numbered `-1`, `-2` for a repeat in document order, as the page renders it. */
  readonly anchor: string;
  /** 0-based index into the page's lines. */
  readonly line: number;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * GitHub's heading slug: links become their text, tags and backticks drop, then every character
 * that is not a letter, digit, mark, connector, `-` or space goes and each space is a `-`. The same
 * rule `scripts/wiki-anchors.ts` holds every wiki link to — the one copy, which it imports.
 */
export const githubSlug = (heading: string): string =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replaceAll('`', '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');

/** Every heading outside a fenced block. A `# comment` inside a ```sh fence is code, not a title. */
export function wikiHeadings(markdown: string): readonly WikiHeading[] {
  const out: WikiHeading[] = [];
  const seen = new Map<string, number>();
  let fenced = false;
  markdown.split('\n').forEach((text, line) => {
    if (isFence(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = HEADING.exec(text);
    if (match === null) return;
    const heading = match[2] ?? '';
    const base = githubSlug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push({
      level: (match[1] ?? '#').length,
      heading,
      anchor: count === 0 ? base : `${base}-${count}`,
      line,
    });
  });
  return out;
}

/** `Upgrading.md` → `Upgrading`; GitHub's chrome (`_Sidebar`, `_Footer`) is navigation, not prose. */
export const wikiPageOf = (file: string): string | undefined =>
  file.endsWith('.md') && !file.startsWith('_') ? file.slice(0, -'.md'.length) : undefined;

/**
 * One page → its entries. The text before the first `##` is the page's own entry, `wiki.<Page>`,
 * titled by its `#` heading; every `##`-or-deeper heading is one more, whose text runs to the next
 * heading of any level — the unit a search scores. `wikiSection` is the unit a reader asks for.
 */
export function wikiEntries(
  page: string,
  markdown: string,
  origin: WikiOrigin,
): readonly DocEntry[] {
  const lines = markdown.split('\n');
  const headings = wikiHeadings(markdown);
  const source = `${origin.dir ?? 'wiki'}/${page}.md`;
  const base = { package: origin.package, version: origin.version, kind: 'guide' as const };
  const body = (from: number, to: number): string =>
    clampDocText(lines.slice(from, to).join('\n').trim());
  const firstSection = headings.find((heading) => heading.level >= 2);
  const title = headings.find((heading) => heading.level === 1);
  const entries: DocEntry[] = [
    {
      ...base,
      topic: `wiki.${page}`,
      title: title?.heading ?? page,
      text: body(title === undefined ? 0 : title.line + 1, firstSection?.line ?? lines.length),
      symbols: [],
      source,
    },
  ];
  headings.forEach((heading, index) => {
    if (heading.level < 2) return;
    entries.push({
      ...base,
      topic: `wiki.${page}#${heading.anchor}`,
      title: heading.heading,
      text: body(heading.line + 1, headings[index + 1]?.line ?? lines.length),
      symbols: [],
      source,
    });
  });
  return entries;
}

/**
 * The whole section an anchor names — its heading, its body and every subsection under it, up to
 * the next heading of the same or a higher level. `undefined` for an anchor the page does not carry.
 */
export function wikiSection(markdown: string, anchor: string): string | undefined {
  const headings = wikiHeadings(markdown);
  const index = headings.findIndex((heading) => heading.anchor === anchor);
  const start = headings[index];
  if (start === undefined) return undefined;
  const end = headings.slice(index + 1).find((heading) => heading.level <= start.level);
  const lines = markdown.split('\n');
  return lines
    .slice(start.line, end?.line ?? lines.length)
    .join('\n')
    .trimEnd();
}

/**
 * Every page in a shipped `wiki/` directory. `Error-Codes.md` is never read: `x errors explain` is
 * the one way to a code, and indexing 400 rows of it would bury every other answer. A directory that
 * is not there is no pages, not a throw — the caller decides whether that is a broken install.
 */
export async function scanWikiDocs(dir: string, origin: WikiOrigin): Promise<readonly DocEntry[]> {
  let files: readonly string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const pages = [...files]
    .sort()
    .map(wikiPageOf)
    .filter((page): page is string => page !== undefined && page !== 'Error-Codes');
  const perPage = await Promise.all(
    pages.map(async (page) => {
      // A listed page can vanish or turn unreadable before it is read — `bun update` rewrites the
      // tarball under a running `x docs`. One page is worth that page's entries, never the whole
      // answer: the rule `scanInstalledDocs` holds for a package.
      try {
        const file = Bun.file(join(dir, `${page}.md`));
        return (await file.exists()) ? wikiEntries(page, await file.text(), origin) : [];
      } catch {
        return [];
      }
    }),
  );
  return perPage.flat();
}
