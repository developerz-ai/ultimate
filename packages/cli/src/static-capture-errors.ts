// The three ways a static export's FILES — image variants and social cards — cannot be made: a
// `src` the export does not hold, a card path no exported page answers, and no browser to take the
// card with. Codes and titles are `error-codes.ts`'s; these are the constructors.

import { renderCauseValue, UltimateError } from '@ultimat3/core';

const listed = (values: readonly string[]): string =>
  values.map((value) => renderCauseValue(value)).join(', ');

export class ImageSourceUnreadableError extends UltimateError {
  constructor(srcs: readonly string[]) {
    super({
      code: 'X_IMAGE_SOURCE_UNREADABLE',
      cause: `responsiveImage() on an exported page named ${listed(srcs)}, and the static export holds no such file, so no variant of it can be written — a CDN would answer every <source> with a 404`,
      fix: "x build --target static --json   # lists the export; put the file under apps/web/site/assets/ and pass asset('assets/<file>') as src, or give an absolute https:// URL",
      meta: { srcs: [...srcs] },
    });
  }
}

export class CardRouteUnknownError extends UltimateError {
  constructor(paths: readonly string[], declaredIn?: string) {
    super({
      code: 'X_SEO_CARD_ROUTE_UNKNOWN',
      cause: `og.capture names ${listed(paths)}${declaredIn === undefined ? '' : ` (in ${declaredIn})`}, and no exported site/ page answers that path, so there is no page to photograph`,
      fix: 'x routes --json   # list the site/ routes; add apps/web/site/<the capture path>/page.tsx at 1200 x 630 with robots: { index: false }, or correct the og.capture path',
      meta: { paths: [...paths] },
    });
  }
}

export class CardBrowserMissingError extends UltimateError {
  constructor(paths: readonly string[]) {
    super({
      code: 'X_SEO_CARD_BROWSER_MISSING',
      cause: `x build --target static photographs ${listed(paths)} as social cards, and no browser was named or found — no CHROME_PATH, PUPPETEER_EXECUTABLE_PATH or SCRAPE_CDP_URL is set and no probed path holds one`,
      fix: 'export CHROME_PATH=/usr/bin/google-chrome   # any Chrome, Chromium or Edge binary; or drop og.capture from the route; the gate build passes --no-capture and needs none',
      meta: { paths: [...paths] },
    });
  }
}
