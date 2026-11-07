// The print layout a PDF is asked for — paper, margins, background, header and footer — and the
// one check that refuses a request no print engine can honour. Decided ONCE, in `page-over-target.ts`,
// before any driver: two sizes resolve silently in Chrome (the format wins), which is an invoice
// laid out on paper nobody asked for.

import type { CaptureFraming } from './capture-clip';
import { pdfOptionsInvalid } from './error-throws-pdf';

/** The named paper sizes every print engine knows. Lowercase: the spelling is this package's. */
export const PDF_FORMATS = [
  'letter',
  'legal',
  'tabloid',
  'ledger',
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
] as const;

export type PdfFormat = (typeof PDF_FORMATS)[number];

/** Millimetres on each side. An absent side is the engine's own default. */
export interface PdfMarginMm {
  readonly top?: number | undefined;
  readonly right?: number | undefined;
  readonly bottom?: number | undefined;
  readonly left?: number | undefined;
}

/**
 * What a print engine lays a document out on. Exactly one size: a `format`, or `widthMm` WITH
 * `heightMm`, or `preferCssPageSize` (the document's own `@page`) — or none, the engine's letter.
 * `headerHtml` / `footerHtml` are print templates: Chrome fills `.pageNumber`, `.totalPages`,
 * `.date`, `.title` and `.url` inside them.
 */
export interface PdfLayout {
  readonly format?: PdfFormat | undefined;
  readonly widthMm?: number | undefined;
  readonly heightMm?: number | undefined;
  readonly marginMm?: PdfMarginMm | undefined;
  readonly printBackground?: boolean | undefined;
  readonly preferCssPageSize?: boolean | undefined;
  readonly headerHtml?: string | undefined;
  readonly footerHtml?: string | undefined;
}

/** `page.pdf()`'s argument: the layout, plus the framing every capture shares (a clip is refused). */
export interface PdfRequest extends CaptureFraming, PdfLayout {}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

const isFormat = (value: string): value is PdfFormat =>
  (PDF_FORMATS as readonly string[]).includes(value);

function measure(field: string, value: number | undefined, floor: 'positive' | 'zero'): void {
  if (value === undefined) return;
  const ok = Number.isFinite(value) && (floor === 'positive' ? value > 0 : value >= 0);
  if (!ok) {
    throw pdfOptionsInvalid(
      `${field} is ${String(value)}, and a page measure is a finite number of millimetres${floor === 'positive' ? ' above zero' : ', zero or more'}`,
      { field },
    );
  }
}

/**
 * The layout half of a request, checked. Answers only the fields that were given, so a driver sees
 * exactly what the caller asked for and supplies its own default for the rest.
 */
export function pdfLayoutOf(request: PdfRequest): PdfLayout {
  const { format, widthMm, heightMm, preferCssPageSize } = request;
  if (format !== undefined && !isFormat(format)) {
    throw pdfOptionsInvalid(`format "${String(format)}" is not one of ${PDF_FORMATS.join(', ')}`, {
      field: 'format',
    });
  }
  measure('widthMm', widthMm, 'positive');
  measure('heightMm', heightMm, 'positive');
  for (const side of SIDES) measure(`marginMm.${side}`, request.marginMm?.[side], 'zero');
  const sized = widthMm !== undefined || heightMm !== undefined;
  if (format !== undefined && sized) {
    throw pdfOptionsInvalid(
      `the request names format "${format}" and widthMm/heightMm, and Chrome silently lays it out on the format`,
      { field: 'format' },
    );
  }
  if (sized && (widthMm === undefined || heightMm === undefined)) {
    throw pdfOptionsInvalid(
      `the request names ${widthMm === undefined ? 'heightMm' : 'widthMm'} alone, which is half a page`,
      { field: widthMm === undefined ? 'heightMm' : 'widthMm' },
    );
  }
  if (preferCssPageSize === true && (format !== undefined || sized)) {
    throw pdfOptionsInvalid(
      'the request names a size and preferCssPageSize: true, and the document @page rule then silently wins over it',
      { field: 'preferCssPageSize' },
    );
  }
  return {
    ...(format === undefined ? {} : { format }),
    ...(widthMm === undefined ? {} : { widthMm }),
    ...(heightMm === undefined ? {} : { heightMm }),
    ...(request.marginMm === undefined ? {} : { marginMm: { ...request.marginMm } }),
    ...(request.printBackground === undefined ? {} : { printBackground: request.printBackground }),
    ...(preferCssPageSize === undefined ? {} : { preferCssPageSize }),
    ...(request.headerHtml === undefined ? {} : { headerHtml: request.headerHtml }),
    ...(request.footerHtml === undefined ? {} : { footerHtml: request.footerHtml }),
  };
}

/** The same layout as one deterministic line — what an offline driver stamps into its bytes. */
export function pdfLayoutText(layout: PdfLayout): string {
  // Sorted by hand: a replacer ARRAY would also filter `marginMm`'s own keys out of the line.
  const margin = layout.marginMm;
  const sides = margin === undefined ? '' : SIDES.map((side) => String(margin[side])).join('/');
  return Object.entries({ ...layout, marginMm: sides === '' ? undefined : sides })
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}
