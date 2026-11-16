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

// Linear by construction, every reader below (CodeQL js/polynomial-redos, sweep 8b-3): the regexes
// they replace answered the same strings and retried a run from each of its characters —
// `/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/` took over 15 s on a CRLF heading of 10k
// spaces, the link pattern over 15 s on 100k `![`, the tag pattern 4.3 s on 100k `<`.

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';
/** What `.` refuses to match without the `s` flag: a heading line holding one is no heading. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * An ATX heading, `#` to `######`: up to three spaces, the marks, a blank, then the text without
 * its closing `#` run (only when a blank precedes it) and without trailing blanks.
 */
function atxHeading(
  text: string,
): { readonly level: number; readonly heading: string } | undefined {
  let at = 0;
  while (at < 3 && text[at] === ' ') at += 1;
  let marks = at;
  while (text[marks] === '#') marks += 1;
  const level = marks - at;
  if (level < 1 || level > 6) return undefined;
  let start = marks;
  while (isBlank(text[start])) start += 1;
  if (start === marks) return undefined;
  const rest = text.slice(start);
  if (LINE_TERMINATOR.test(rest)) return undefined;
  let end = rest.length;
  while (end > 0 && isBlank(rest[end - 1])) end -= 1;
  let closing = end;
  while (closing > 0 && rest[closing - 1] === '#') closing -= 1;
  if (closing === end || closing === 0 || !isBlank(rest[closing - 1])) {
    return { level, heading: rest.slice(0, end) };
  }
  while (isBlank(rest[closing - 1])) closing -= 1;
  return { level, heading: rest.slice(0, closing) };
}

/**
 * `text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')`, as one forward walk: a `[` is closed by the
 * first `]` after it, which must be followed by `(` and then a `)`. Every `[` before that `]` shares
 * it, so a failed one skips past it; with no `]` or no `)` left, no later link can close either.
 * An image's `!` stays behind, and the slug's character filter drops it like any other `!`.
 */
function linksAsText(text: string): string {
  let out = '';
  let kept = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf('[', from);
    const close = open === -1 ? -1 : text.indexOf(']', open + 1);
    if (close === -1) break;
    if (text[close + 1] !== '(') {
      from = close + 1;
      continue;
    }
    const end = text.indexOf(')', close + 2);
    if (end === -1) break;
    out += text.slice(kept, open) + text.slice(open + 1, close);
    kept = end + 1;
    from = kept;
  }
  return out + text.slice(kept);
}

/** `text.replace(/<[^>]+>/g, '')`, as one forward walk: `<` to the next `>`, never `<>` itself. */
function withoutTags(text: string): string {
  let out = '';
  let kept = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf('<', from);
    const close = open === -1 ? -1 : text.indexOf('>', open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      from = close;
      continue;
    }
    out += text.slice(kept, open);
    kept = close + 1;
    from = kept;
  }
  return out + text.slice(kept);
}

/**
 * GitHub's heading slug: links become their text, tags and backticks drop, then every character
 * that is not a letter, digit, mark, connector, `-` or space goes and each space is a `-`. The same
 * rule `scripts/wiki-anchors.ts` holds every wiki link to — the one copy, which it imports.
 */
export const githubSlug = (heading: string): string =>
  withoutTags(linksAsText(heading))
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
    const match = atxHeading(text);
    if (match === undefined) return;
    const { heading, level } = match;
    const base = githubSlug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push({
      level,
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
 * The error reference's page set: the index `Error-Codes` and one `Error-Codes-<owner>` per owner.
 * The one predicate `x docs` and its section reader both exclude by — `x errors explain` is the one
 * way to a code, and indexing a thousand rows would bury every other answer.
 */
export const isErrorCodesPage = (page: string): boolean =>
  page === 'Error-Codes' || page.startsWith('Error-Codes-');

/**
 * Every page in a shipped `wiki/` directory but the error reference (`isErrorCodesPage`). A
 * directory that is not there is no pages, not a throw — the caller decides whether that is a
 * broken install.
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
    .filter((page): page is string => page !== undefined && !isErrorCodesPage(page));
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
