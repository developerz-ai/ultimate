// The reader's shapes: what comes in (a wiki file's name and text) and every piece that goes out.

/** One file of `wiki/`, as read: `Getting-Started.md` and its text. */
export interface WikiFile {
  readonly file: string;
  readonly markdown: string;
}

/** A heading on a rendered piece, under the anchor the piece itself carries. */
export interface PieceHeading {
  readonly level: number;
  readonly text: string;
  readonly anchor: string;
}

/** One rendered page: a wiki page, the error-code index, an upgrade major, the upgrade index. */
export interface DocPiece {
  /** The site path: `/getting-started`, `/upgrading/30`. Never a trailing slash. */
  readonly url: string;
  /** The wiki file it came from, so a refusal names the file to edit. */
  readonly file: string;
  readonly title: string;
  /** The first prose line: the meta description and the search snippet. */
  readonly lead: string;
  /** The body, links rewritten, the `#` title line removed: the page prints its own `h1`. */
  readonly markdown: string;
  readonly headings: readonly PieceHeading[];
}

/** One cell of an error-code row, under its column's own header: `Means`, `Typical cause`, `Fix`. */
export interface CodeCell {
  readonly label: string;
  readonly markdown: string;
}

/** One row of `wiki/Error-Codes.md` that documents a code. */
export interface CodeRow {
  /** The row's section: `Entity and database`, with the index URL that lists it. */
  readonly section: { readonly title: string; readonly url: string };
  readonly cells: readonly CodeCell[];
}

/**
 * One `X_*` code's page. Usually one row; a code two packages describe from two sides
 * (`X_NOT_IMPLEMENTED`) has a row in each section, and the page carries both, in page order.
 */
export interface CodePiece {
  readonly code: string;
  readonly url: string;
  readonly rows: readonly CodeRow[];
}

/** Everything the site renders, read from `wiki/` in one pass. */
export interface DocsCorpus {
  readonly pages: readonly DocPiece[];
  readonly codes: readonly CodePiece[];
  /** Ordered newest major first, as `wiki/Upgrading.md` orders them. */
  readonly majors: readonly (DocPiece & { readonly major: number })[];
}
