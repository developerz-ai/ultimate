// What `x build --target static` reports: every page it wrote, every route it did not and why, and
// where the stats and the inventory landed. Split from `prerender.ts`, which decides what is
// written; this file only names the shapes the report carries.

import type { SkippedRoute, UnmeasuredRoute } from './static-report';

export interface PrerenderedPage {
  /** The DECLARED route, `/blog/:slug` — one route can write many pages, and the report groups them. */
  readonly route: string;
  /** The URL the page is served at — `/en/pricing` for a non-default locale. */
  readonly path: string;
  /** The locale the page was rendered in. */
  readonly locale: string;
  /** Relative to `out`, POSIX — under `<locale>/` for a non-default locale. */
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
}

export interface PrerenderReport {
  readonly out: string;
  readonly buildId: string;
  readonly pages: readonly PrerenderedPage[];
  /**
   * Every declared route that wrote no file, WITH the cause. A bare path list was the whole of
   * #242: `.x/static/` held a partial site, the report said only which paths were missing, and a
   * screenshot tool pointed at the directory filed "the island did not mount" against a route that
   * had never been in the artifact. The reason is what tells an author whether an edit exists.
   */
  readonly skipped: readonly SkippedRoute[];
  /**
   * Routes whose budget this build could not weigh, with the reason. `X_BUDGET_UNMEASURED` is what
   * the gate then reports for each; this is the half that says WHY, which a per-route finding read
   * off a stats file cannot know.
   */
  readonly unmeasured: readonly UnmeasuredRoute[];
  /** Where the measured stats landed, for the `budgets` gate step to read. */
  readonly stats: string;
  /** Where the emitted/skipped inventory landed, for `x build --target static` to read back. */
  readonly report: string;
  /** Client entries emitted, one chunk each. Reported so "which JS shipped?" needs no unzip. */
  readonly islands: readonly string[];
  /** Surface stylesheets emitted, one file each — the CSS half of the same question. */
  readonly styles: readonly string[];
  /**
   * What the service worker could not express, and what its precache manifest weighs too much of.
   *
   * `PrecacheManifest.warnings` had no reader anywhere in the tree — the precache budget was, in
   * `wiki/Troubleshooting.md`'s own words, "a designed thing that is not one" (#390). An install
   * that stalls on a bad connection is invisible on a laptop and fatal on a phone, so the number
   * has to reach the build's own report. Empty for an app with no service worker.
   */
  readonly serviceWorkerWarnings: readonly string[];
  /** What this build could not get right on its own — today, a production build with no origin. */
  readonly warnings: readonly string[];
  /** The origin every absolute URL in the export was built against — hand it to `siteSeo`. */
  readonly origin: string;
}
