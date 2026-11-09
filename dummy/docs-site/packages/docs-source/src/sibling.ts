// The `.md` sibling of every page: the same body an agent reads without parsing HTML, at the page's
// URL plus `.md`. Built from the piece, so the page and its markdown cannot say different things.

import type { CodePiece, DocPiece } from './types';

/** `/getting-started` → `getting-started.md`; the site's front, `/`, has no sibling. */
export const siblingPath = (url: string): string => `${url.replace(/^\//, '')}.md`;

export const pieceMarkdown = (piece: DocPiece): string => `# ${piece.title}\n\n${piece.markdown}\n`;

/** One block per row, each cell under its column's own header from the wiki table. */
export const codeMarkdown = (piece: CodePiece): string =>
  `# ${piece.code}\n\n${piece.rows
    .map((row) =>
      [
        ...row.cells.map((cell) => `## ${cell.label}\n\n${cell.markdown}`),
        `[${row.section.title}](${row.section.url})`,
      ].join('\n\n'),
    )
    .join('\n\n---\n\n')}\n`;
