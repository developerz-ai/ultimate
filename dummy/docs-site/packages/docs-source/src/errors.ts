// The reader's refusals. Each one stops the static build and names the wiki file to edit: a docs
// site that printed a dead link, a missing code or an empty description would ship it silently.

import { defineError } from '@ultimat3/core';

interface DeadLink {
  /** `Getting-Started.md`, the wiki file the link is written in. */
  readonly file: string;
  /** 1-based line in that file, as an editor counts. */
  readonly line: number;
  readonly target: string;
  readonly why: string;
}

export const DocsLinkDeadError = defineError<DeadLink>({
  code: 'X_DOCS_LINK_DEAD',
  title: 'a wiki link resolves to no page or heading',
  offSocket: true,
  cause: (link) => `wiki/${link.file}:${link.line} links to ${link.target}: ${link.why}`,
  fix: (link) =>
    `bunx x build --target static --json   # after correcting the link at wiki/${link.file}:${link.line} to a page in wiki/ or a heading it carries`,
});

export const DocsCodePageMissingError = defineError<{ readonly codes: readonly string[] }>({
  code: 'X_DOCS_CODE_PAGE_MISSING',
  title: 'a declared X_* code has no built page',
  offSocket: true,
  cause: ({ codes }) =>
    `${codes.length} code(s) the framework registers have no row in wiki/Error-Codes.md, so no page: ${codes.slice(0, 10).join(', ')}`,
  fix: ({ codes }) =>
    `bunx x errors explain ${codes[0] ?? 'X_CODE'} --json   # its title, cause and fix: add the row to wiki/Error-Codes.md under the owning package's section`,
});

export const DocsLeadEmptyError = defineError<{ readonly file: string; readonly piece: string }>({
  code: 'X_DOCS_LEAD_EMPTY',
  title: 'a docs page has no line to describe it',
  offSocket: true,
  cause: ({ file, piece }) =>
    `${piece} (from wiki/${file}) has no prose line under its heading, so its meta description would be empty`,
  fix: ({ file }) =>
    `bunx x build --target static --json   # after writing a one-line lead under the heading in wiki/${file}`,
});

export const DocsPieceOversizeError = defineError<{
  readonly file: string;
  readonly piece: string;
  readonly chars: number;
  readonly cap: number;
}>({
  code: 'X_DOCS_PIECE_OVERSIZE',
  title: 'a docs page is past the markdown renderer size cap',
  offSocket: true,
  cause: ({ file, piece, chars, cap }) =>
    `${piece} (from wiki/${file}) is ${chars} characters against the renderer's ${cap}: past it the rest prints as plain text, never a page`,
  fix: ({ file }) =>
    `bunx x build --target static --json   # after splitting the section in wiki/${file} under more headings`,
});

export const DocsSecondTitleError = defineError<{
  readonly file: string;
  readonly heading: string;
}>({
  code: 'X_DOCS_SECOND_TITLE',
  title: 'a wiki page carries a second # heading',
  offSocket: true,
  cause: ({ file, heading }) =>
    `wiki/${file} has a second level-1 heading, "${heading}": the page prints its one h1 from the first, and this one would be another`,
  fix: ({ file }) =>
    `bunx x build --target static --json   # after making the second # heading in wiki/${file} a ## heading`,
});
