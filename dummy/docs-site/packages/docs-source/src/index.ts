// Public API of the wiki reader: read the corpus, and the URL rules the routes and the build share.

export { assertCodePages } from './code-pages';
export type { CorpusOptions } from './corpus';
export { readCorpus } from './corpus';
export { codeUrl } from './error-table';
export {
  DocsCodePageMissingError,
  DocsLeadEmptyError,
  DocsLinkDeadError,
  DocsPieceOversizeError,
  DocsSecondTitleError,
} from './errors';
export { clipText, plainText } from './lead';
export { searchEntries } from './search-entries';
export { codeMarkdown, pieceMarkdown, siblingPath } from './sibling';
export { pageUrl } from './targets';
export type {
  CodeCell,
  CodePiece,
  CodeRow,
  DocPiece,
  DocsCorpus,
  PieceHeading,
  WikiFile,
} from './types';
export { majorUrl } from './upgrading';
