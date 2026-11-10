// A checked PDF layout in the PROTOCOL's own words — `Page.printToPDF`'s parameters — for the raw-CDP
// printer `pdf()` drives. `pdf-print.ts` is the same layout in puppeteer's words; the two exist
// because the two callers speak to different things. Inches, because the protocol counts in them.

import type { PdfFormat, PdfLayout } from './pdf-request';

const MM_PER_INCH = 25.4;

/** Width × height in millimetres, portrait — ISO 216 and the ANSI sizes, as every engine has them. */
const PAPER_MM: ReadonlyMap<PdfFormat, readonly [number, number]> = new Map([
  ['letter', [215.9, 279.4]],
  ['legal', [215.9, 355.6]],
  ['tabloid', [279.4, 431.8]],
  ['ledger', [431.8, 279.4]],
  ['a0', [841, 1189]],
  ['a1', [594, 841]],
  ['a2', [420, 594]],
  ['a3', [297, 420]],
  ['a4', [210, 297]],
  ['a5', [148, 210]],
  ['a6', [105, 148]],
]);

/** An empty band rather than an absent one, for `pdf-print.ts`'s reason: Chrome's own date and URL. */
const BLANK_TEMPLATE = '<span></span>';

const inches = (mm: number): number => mm / MM_PER_INCH;

/** The paper, in millimetres, when the layout names one. `undefined` is the engine's letter. */
const paperOf = (layout: PdfLayout): readonly [number, number] | undefined => {
  if (layout.format !== undefined) return PAPER_MM.get(layout.format);
  if (layout.widthMm !== undefined && layout.heightMm !== undefined) {
    return [layout.widthMm, layout.heightMm];
  }
  return undefined;
};

/**
 * `Page.printToPDF`'s params for a layout `pdfLayoutOf` already checked. Only the fields the caller
 * gave are sent; the bytes come back base64 in the reply (`transferMode: 'ReturnAsBase64'`).
 */
export function printToPdfParams(layout: PdfLayout): Record<string, unknown> {
  const paper = paperOf(layout);
  const margin = layout.marginMm;
  const band = layout.headerHtml !== undefined || layout.footerHtml !== undefined;
  return {
    transferMode: 'ReturnAsBase64',
    ...(paper === undefined ? {} : { paperWidth: inches(paper[0]), paperHeight: inches(paper[1]) }),
    ...(margin?.top === undefined ? {} : { marginTop: inches(margin.top) }),
    ...(margin?.right === undefined ? {} : { marginRight: inches(margin.right) }),
    ...(margin?.bottom === undefined ? {} : { marginBottom: inches(margin.bottom) }),
    ...(margin?.left === undefined ? {} : { marginLeft: inches(margin.left) }),
    ...(layout.printBackground === undefined ? {} : { printBackground: layout.printBackground }),
    ...(layout.preferCssPageSize === undefined
      ? {}
      : { preferCSSPageSize: layout.preferCssPageSize }),
    ...(band
      ? {
          displayHeaderFooter: true,
          headerTemplate: layout.headerHtml ?? BLANK_TEMPLATE,
          footerTemplate: layout.footerHtml ?? BLANK_TEMPLATE,
        }
      : {}),
  };
}
