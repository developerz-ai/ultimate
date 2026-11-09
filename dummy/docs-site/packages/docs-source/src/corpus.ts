// `wiki/*.md` → every piece the site renders, links rewritten to the piece that holds their
// target. One pass: split each page, learn where every wiki anchor landed, then rewrite. A link
// that lands nowhere stops the build here, naming `wiki/<file>:<line>`.

import { type WikiHeading, wikiHeadings } from '@ultimat3/manifest';
import { type Draft, draftHeadings, linesOf } from './draft';
import { codeUrl, splitErrorCodes } from './error-table';
import {
  DocsLeadEmptyError,
  DocsLinkDeadError,
  DocsPieceOversizeError,
  DocsSecondTitleError,
} from './errors';
import { stripComments } from './fences';
import { leadOf, plainText } from './lead';
import { type LinkResolver, rewriteLinks } from './links';
import { pageOfFile, pageUrl, wikiTarget } from './targets';
import type { CodePiece, DocPiece, DocsCorpus, WikiFile } from './types';
import { splitUpgrading } from './upgrading';

export interface CorpusOptions {
  /** The markdown renderer's cap, in characters: past it a piece would print as plain text. */
  readonly maxChars: number;
  /** Where `[x](_Footer)` lands: the GitHub wiki's footer is the site layout's. */
  readonly footer: string;
}

interface Landing {
  readonly url: string;
  readonly local: string | undefined;
}

interface Split {
  readonly page: string;
  readonly file: string;
  readonly main: string;
  readonly headings: readonly WikiHeading[];
  /** Every draft, for where anchors land; `pages` are the ones that are not a major. */
  readonly drafts: readonly Draft[];
  readonly pages: readonly Draft[];
  readonly majors: readonly (Draft & { readonly major: number })[];
  readonly codes: ReturnType<typeof splitErrorCodes>['codes'];
}

function split(page: string, file: string, markdown: string): Split {
  const text = stripComments(markdown);
  const lines = text.split('\n');
  const headings = wikiHeadings(text);
  const [h1, second] = headings.filter((heading) => heading.level === 1);
  // The page prints its own `h1` from the first; the body renders `#` as `h1` too, so a second
  // one would be a second title on the page.
  if (second !== undefined) throw new DocsSecondTitleError({ file, heading: second.heading });
  const body = { from: h1 === undefined ? 0 : h1.line + 1, title: h1?.heading ?? page };
  const base = { page, file, headings, majors: [], codes: [] };
  if (page === 'Upgrading') {
    const { index, majors } = splitUpgrading(file, lines, headings, body);
    return { ...base, main: index.url, drafts: [index, ...majors], pages: [index], majors };
  }
  if (page === 'Error-Codes') {
    const { index, codes } = splitErrorCodes(file, lines, headings, body);
    return { ...base, main: index.url, drafts: [index], pages: [index], codes };
  }
  const url = pageUrl(page);
  const draft = { url, file, title: body.title, lines: linesOf(lines, body.from, lines.length) };
  return { ...base, main: url, drafts: [draft], pages: [draft] };
}

/** Every wiki anchor of one page → the piece it landed on and the anchor it carries there. */
function landings(one: Split): ReadonlyMap<string, Landing> {
  const map = new Map<string, Landing>();
  for (const draft of one.drafts) {
    for (const heading of draftHeadings(draft, one.headings)) {
      map.set(heading.wiki, { url: draft.url, local: heading.anchor });
    }
  }
  // A heading a split consumed — the `#` title, a major's own `##` — lands on the piece its body
  // opens, at the top of it.
  for (const heading of one.headings) {
    if (map.has(heading.anchor)) continue;
    const draft = one.drafts.find((d) => d.lines.some((line) => line.origin === heading.line + 1));
    map.set(heading.anchor, { url: draft?.url ?? one.main, local: undefined });
  }
  return map;
}

export function readCorpus(files: readonly WikiFile[], options: CorpusOptions): DocsCorpus {
  const splits = files.flatMap((wiki) => {
    const page = pageOfFile(wiki.file);
    return page === undefined ? [] : [split(page, wiki.file, wiki.markdown)];
  });
  const mains = new Map(splits.map((one) => [one.page, one.main]));
  const anchors = new Map(splits.map((one) => [one.page, landings(one)]));

  const resolverFor =
    (one: Split, url: string, originOf: (line: number) => number): LinkResolver =>
    (link) => {
      const target = wikiTarget(link.target, one.page);
      if (target === undefined) return undefined;
      if (target.page === '_Footer') return options.footer;
      const dead = (why: string): never => {
        throw new DocsLinkDeadError({
          file: one.file,
          line: originOf(link.line) + 1,
          target: link.target,
          why,
        });
      };
      const main = mains.get(target.page) ?? dead(`wiki/${target.page}.md does not exist`);
      if (target.anchor === undefined) return main;
      const landing =
        anchors.get(target.page)?.get(target.anchor) ??
        dead(`wiki/${target.page}.md has no heading whose anchor is #${target.anchor}`);
      const hash = landing.local === undefined ? '' : `#${landing.local}`;
      return landing.url === url && hash !== '' ? hash : `${landing.url}${hash}`;
    };

  const piece = (one: Split, draft: Draft): DocPiece => {
    const resolve = resolverFor(one, draft.url, (line) => draft.lines[line]?.origin ?? 0);
    const markdown = rewriteLinks(draft.lines.map((line) => line.text).join('\n'), resolve).trim();
    const lead = leadOf(markdown);
    if (lead === '') throw new DocsLeadEmptyError({ file: one.file, piece: draft.url });
    if (markdown.length > options.maxChars) {
      throw new DocsPieceOversizeError({
        file: one.file,
        piece: draft.url,
        chars: markdown.length,
        cap: options.maxChars,
      });
    }
    const headings = draftHeadings(draft, one.headings).map(({ wiki: _, ...heading }) => heading);
    return { url: draft.url, file: one.file, title: draft.title, lead, markdown, headings };
  };

  const pages = splits.flatMap((one) => one.pages.map((draft) => piece(one, draft)));
  const majors = splits.flatMap((one) =>
    one.majors.map((draft) => ({ ...piece(one, draft), major: draft.major })),
  );
  const codes = new Map<string, CodePiece>();
  for (const one of splits) {
    for (const row of one.codes) {
      const section = anchors.get(one.page)?.get(row.section.anchor);
      const sectionUrl =
        section?.local === undefined ? one.main : `${section.url}#${section.local}`;
      for (const code of row.codes) {
        const url = codeUrl(code);
        const resolve = resolverFor(one, url, () => row.origin);
        const rendered = {
          section: { title: plainText(row.section.title), url: sectionUrl },
          cells: row.cells.map((cell) => ({
            ...cell,
            markdown: rewriteLinks(cell.markdown, resolve),
          })),
        };
        const known = codes.get(code);
        codes.set(code, { code, url, rows: [...(known?.rows ?? []), rendered] });
      }
    }
  }
  return { pages, codes: [...codes.values()], majors };
}
