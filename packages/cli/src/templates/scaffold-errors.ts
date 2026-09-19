// The two error pages `x new` writes — `apps/web/site/errors/404.html` and `500.html`, the files
// `packages/cli/src/error-pages.ts` serves verbatim for those statuses and the static export
// carries as `404.html`. Self-contained documents by construction: a 500 is answered when the app's
// own stylesheet may be the thing that failed, so nothing here links a bundle, loads a font or runs
// a script. The `<style>` body is hashed into `style-src` at boot (`error-page-csp.ts`), which is
// what lets the enforced policy a container sends admit it.

import type { GeneratedFile, NameSet } from './naming';
import { titleCase } from './naming';

/**
 * The same two hex values `app.config.ts`'s `pwa.colors` declares — one source, read by both
 * templates, so the splash a browser paints before any stylesheet and the page it shows when the
 * stylesheet never arrives agree. Raw hex is legal in these two places and nowhere else in an app:
 * the raw-colour guard scans `.scss` (a page with no stylesheet has no token to read), and an
 * install prompt has no stylesheet either.
 */
export const PWA_COLORS = {
  themeColor: '#1b1f3b',
  lightBackground: '#ffffff',
  darkBackground: '#0b0d1a',
} as const;

/** One page per status, English only: the file is served as bytes, so no translator runs. */
interface ErrorCopy {
  readonly status: number;
  readonly title: string;
  readonly body: string;
}

const COPY: readonly ErrorCopy[] = [
  {
    status: 404,
    title: 'Page not found',
    body: 'There is nothing at this address. The link may be old, or the page may have moved.',
  },
  {
    status: 500,
    title: 'Something went wrong',
    body: 'The server could not finish this request. It has been recorded; try again in a moment.',
  },
];

/**
 * `prefers-color-scheme` rather than `data-theme`: the theme boot script is inlined by the
 * framework into documents it RENDERS, and this file is served as-is, so the OS preference is the
 * only signal it has. The dark palette is the default and the light one is the media override,
 * matching the `theme.defaultMode` the scaffold sets.
 */
const style = (): string => `
      :root {
        color-scheme: dark light;
        --bg: ${PWA_COLORS.darkBackground};
        --fg: #e6e8f0;
        --muted: #9aa0b5;
        --accent: #8b93ff;
        --line: #262a45;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: ${PWA_COLORS.lightBackground};
          --fg: ${PWA_COLORS.themeColor};
          --muted: #5d6280;
          --accent: #3b46d6;
          --line: #dfe2ee;
        }
      }
      * { box-sizing: border-box; margin: 0; }
      html, body { min-height: 100%; }
      body {
        display: grid;
        place-items: center;
        padding: 2rem;
        background: var(--bg);
        color: var(--fg);
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        line-height: 1.5;
      }
      main { max-width: 32rem; }
      .status {
        font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
        font-size: 0.75rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--accent);
      }
      h1 { margin-top: 0.5rem; font-size: 2rem; font-weight: 600; letter-spacing: -0.02em; }
      p { margin-top: 0.75rem; color: var(--muted); }
      a {
        display: inline-block;
        margin-top: 1.5rem;
        padding: 0.6rem 1rem;
        border: 1px solid var(--line);
        border-radius: 0.5rem;
        color: var(--fg);
        text-decoration: none;
      }
      a:hover { border-color: var(--accent); }
      a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    `;

const page = (app: NameSet, copy: ErrorCopy): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <meta name="theme-color" content="${PWA_COLORS.themeColor}">
    <title>${copy.title} · ${titleCase(app.raw)}</title>
    <style>${style()}</style>
  </head>
  <body>
    <main>
      <p class="status">${String(copy.status)}</p>
      <h1>${copy.title}</h1>
      <p>${copy.body}</p>
      <a href="/">Back to ${titleCase(app.raw)}</a>
    </main>
  </body>
</html>
`;

/** `apps/web/site/errors/404.html` and `500.html`, in status order. */
export const errorPageFiles = (app: NameSet): readonly GeneratedFile[] =>
  COPY.map((copy) => ({
    path: `apps/web/site/errors/${String(copy.status)}.html`,
    contents: page(app, copy),
  }));
