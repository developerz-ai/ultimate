// What a document renderer is handed by the boot that knows it: the island resolver and every
// document-level head the route itself cannot decide. Split out of `runtime-render.ts` at its
// 500-line ceiling; one declaration for `x dev`, the container and the static export.

import type { ClientSyncHead } from '@ultimat3/render';
import type { NavigationDocumentHead } from './page-navigation';

/**
 * Specifier → built chunk URL, bound to the route file the specifier is written relative to.
 * Supplied by whoever built the islands (`x dev`, the container, the static build); absent means
 * no island was built, and a page that renders one then fails by name rather than emitting a
 * `data-x-entry` nothing can import.
 */
export type IslandResolver = (routeFile: string) => (src: string) => string;

export interface DocumentOptions {
  readonly resolveIsland?: IslandResolver;
  /**
   * `<link rel="manifest">`, both `theme-color` metas and the apple-touch links — `PwaArtifacts.head`
   * from `pwa-artifacts.ts`, or absent when the app is not installable.
   *
   * A document-level string rather than something a route's `meta()` returns: it is the same three
   * elements on every page of the app, an installable app is one whose EVERY page carries them
   * (a browser offers the install on whichever page the visitor landed on), and `headFromMeta`
   * projects per-route SEO. Passed through `DocumentOptions` for `resolveIsland`'s reason — the
   * boot knows it, the renderer cannot ask.
   */
  readonly pwaHead?: string | ((locale: string) => string);
  /**
   * The no-flash theme `<script>` from `theme-boot.ts`, or absent for a caller that renders no
   * documents a browser paints. Document-level for `pwaHead`'s reason — the same tag on every page,
   * decided by `app.config.ts`, which the boot read and the renderer cannot.
   */
  readonly themeHead?: string;
  /**
   * The page's sync target — `pageSync(…).head` — rendered as render's `clientSyncTags` on every
   * document this process serves. Principal-free, so a shareable document carries it too; absent
   * for a caller that serves no socket at all (the static export).
   */
  readonly sync?: ClientSyncHead;
  /**
   * The record types the app persists (`entity(…, { persist: true })`), read per render. Rendered
   * as `ultimate-persist` beside the scope tag only — persistence is per principal, so a document
   * with no scope carries none.
   */
  readonly persisted?: () => readonly string[];
  /**
   * The public origin canonical, `og:url` and hreflang are absolute against — `publicOrigin()`
   * from `site-config.ts`. Absent, the request's own origin: a relative canonical is one a crawler
   * resolves against whatever host it happened to fetch from, a CDN's or a preview's.
   */
  readonly origin?: string;
  /**
   * The client router — `pageNavigation(…).head`. A document of a surface listed in
   * `navigation.client` names it; every other document carries none of it.
   */
  readonly navigation?: NavigationDocumentHead;
  /**
   * `<script type="speculationrules">` — `pageSpeculation(…).head` — on every document that names
   * NO client router: the browser prefetches the next page instead. A document with the router
   * carries none, because the router prefetches by its own rules.
   */
  readonly speculationHead?: string;
}
