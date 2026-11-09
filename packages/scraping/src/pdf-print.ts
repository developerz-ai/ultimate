// A checked PDF layout in the CDP library's own words: millimetres become CSS lengths, a format its
// capitalised name, a header or footer turns the print engine's header band on. Only the fields
// the caller gave are sent — the engine's defaults stay the engine's.

import type { CdpPdfOptions } from './cdp-port';
import type { PdfFormat, PdfLayout } from './pdf-request';

/** A `Map`, never a record indexed by the caller's string: `format: 'constructor'` names nothing. */
const LIBRARY_FORMAT: ReadonlyMap<PdfFormat, string> = new Map([
  ['letter', 'Letter'],
  ['legal', 'Legal'],
  ['tabloid', 'Tabloid'],
  ['ledger', 'Ledger'],
  ['a0', 'A0'],
  ['a1', 'A1'],
  ['a2', 'A2'],
  ['a3', 'A3'],
  ['a4', 'A4'],
  ['a5', 'A5'],
  ['a6', 'A6'],
]);

const mm = (value: number): string => `${String(value)}mm`;

/**
 * An empty template, never an absent one, for the band the caller left blank: with the band on and
 * a template missing, Chrome prints its own date and URL there — an invoice footer nobody wrote.
 */
const BLANK_TEMPLATE = '<span></span>';

export function printOptionsOf(layout: PdfLayout): CdpPdfOptions {
  const margin = layout.marginMm;
  const format = layout.format === undefined ? undefined : LIBRARY_FORMAT.get(layout.format);
  const band = layout.headerHtml !== undefined || layout.footerHtml !== undefined;
  return {
    ...(format === undefined ? {} : { format }),
    ...(layout.widthMm === undefined ? {} : { width: mm(layout.widthMm) }),
    ...(layout.heightMm === undefined ? {} : { height: mm(layout.heightMm) }),
    ...(margin === undefined
      ? {}
      : {
          margin: {
            ...(margin.top === undefined ? {} : { top: mm(margin.top) }),
            ...(margin.right === undefined ? {} : { right: mm(margin.right) }),
            ...(margin.bottom === undefined ? {} : { bottom: mm(margin.bottom) }),
            ...(margin.left === undefined ? {} : { left: mm(margin.left) }),
          },
        }),
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
