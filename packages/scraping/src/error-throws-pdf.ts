// The failure mode of a PDF layout request. Split from `error-throws.ts`, which stands at its size
// ceiling; the code itself stays declared in `errors.ts` — one registry, one place.

import { ScrapeError } from './errors';

/**
 * A layout no print engine lays out as asked. `reason` is built by `pdf-request.ts` from the
 * caller's own numbers and literal format names — never from an unknown value.
 */
export const pdfOptionsInvalid = (reason: string, meta: { readonly field: string }): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PDF_OPTIONS_INVALID',
    cause: `page.pdf() cannot lay this document out: ${reason}`,
    fix: "page.pdf({ format: 'a4', marginMm: { top: 12, bottom: 12 } }) — exactly one size: a format, or widthMm with heightMm, or preferCssPageSize alone",
    meta: { field: meta.field },
  });
