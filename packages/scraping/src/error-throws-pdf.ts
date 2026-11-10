// The failure mode of a PDF layout request. Split from `error-throws.ts`, which stands at its size
// ceiling; the code itself stays declared in `errors.ts` — one registry, one place.

import { isRetryableStatus, renderCauseValue, renderFixShellArg } from '@ultimat3/core';
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

/** No server to load the route from: `APP_URL` unset and no `origin` on the declaration. */
export const pdfOriginMissing = (): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PDF_ORIGIN_MISSING',
    cause:
      'pdf() has no origin to load its route from: APP_URL is unset in this process and the declaration names no origin',
    fix: "export APP_URL=https://your.app   # or pdf({ origin: () => 'http://127.0.0.1:3000' }) in the declaring file",
  });

/** `route()` answered something the printing browser would load from another origin. */
export const pdfRouteInvalid = (route: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PDF_ROUTE_INVALID',
    cause: `pdf() route() answered ${renderCauseValue(route)}, which is not a path on this app's origin — the printing browser loads nothing else`,
    fix: "pdf({ route: ({ input }) => '/invoices/' + input.id + '/print' })   # route() answers a path on this app, never a URL",
  });

/**
 * The page answered an error status. A 4xx that no retry can change (a missing record, a route the
 * printing browser may not read) is terminal on the instance; a 5xx or 429 stays retryable.
 */
export const pdfRouteFailed = (url: string, status: number): ScrapeError => {
  const path = new URL(url).pathname;
  return new ScrapeError({
    code: 'X_SCRAPE_PDF_ROUTE_FAILED',
    cause: `the route pdf() printed, ${renderCauseValue(path)}, answered HTTP ${String(status)}: printing it would store an error page as the document`,
    fix: `curl -i "$APP_URL"${renderFixShellArg(path, '/<the path the cause names>')}   # a private route needs pdf({ headers }); a missing one, a route() naming a record that exists`,
    meta: { status },
    retry: status >= 400 && status < 500 && !isRetryableStatus(status) ? 'terminal' : 'retryable',
  });
};

/** Every render slot stayed busy for the whole queue deadline: a burst, not a broken page. */
export const pdfBusy = (input: {
  readonly maxConcurrent: number;
  readonly queueTimeoutMs: number;
}): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PDF_BUSY',
    cause: `all ${String(input.maxConcurrent)} pdf() render slot(s) stayed busy for ${String(input.queueTimeoutMs)}ms — each holds a live Chrome, so the renderer bounds them rather than let a burst exhaust this process's memory`,
    fix: `pdf({ renderer: chromePdfRenderer({ maxConcurrent: ${String(input.maxConcurrent * 2)} }) })   # only on a host with the memory for it; otherwise the caller retries later`,
    meta: { maxConcurrent: input.maxConcurrent, queueTimeoutMs: input.queueTimeoutMs },
  });
