// Speculation Rules for the documents that carry NO client router, composed ONCE for `x dev`, the
// container and the static export: `navigation.speculation` from `app.config.ts`, the pages the
// route table knows to be a pure read, the one `<script type="speculationrules">` every such
// document carries, and the `script-src` source that admits exactly that body. A browser fetches
// the next page's document on pointer rest, so a full-page navigation between prerendered pages
// paints from memory — and the page still ships 0kb of JavaScript (axiom 6).

import type { NavigationSurface, SpeculationConfig } from '@ultimat3/core';
import { DEFAULT_SPECULATION, localeSegment } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import type { AppLocaleSet } from '@ultimat3/i18n/app-catalogs';
import type { RouteDescriptor, RouteEntry } from '@ultimat3/render';
import {
  describePages,
  renderHead,
  routeEntries,
  speculationPattern,
  speculationRulesBody,
  speculationRulesTag,
} from '@ultimat3/render';
import { loadAppConfig } from './app-config-load';

/**
 * `navigation.speculation` off the one loader (`app-config-load.ts`), which holds it to core's
 * `resolveSpeculation` — the default (on, `'moderate'`) for a root with no config file.
 */
export async function loadSpeculation(root: string): Promise<SpeculationConfig> {
  return (await loadAppConfig(root))?.navigation.speculation ?? DEFAULT_SPECULATION;
}

/**
 * Whether a browser may fetch this page before anyone asked for it. An ALLOW-list, never "every
 * link but these": a prefetch is a real GET with the visitor's cookies, so the only safe candidates
 * are pages the table itself says are a pure read.
 *
 * - On a surface WITHOUT the client router: a prerendered, shareable document — `static` or `isr`,
 *   no policy, no `no-store`. Such a page ran its `load` at build time, for nobody. An `ssr` page
 *   there has no way to declare that its GET records something (`navigation` is refused on a
 *   surface that did not opt in), so it is never a candidate.
 * - On a client-routed surface: only a page that declared `navigation: 'prefetch'` — the app's own
 *   statement that its GET is a pure read, the same one the router's prefetch obeys.
 * - Never an `api/` route, a `navigation: 'document'` page, or an `offline: 'network-only'` one.
 */
export function speculationCandidate(
  entry: Pick<RouteEntry, 'surface' | 'config'>,
  described: Pick<RouteDescriptor, 'mode' | 'offline' | 'personal'>,
  client: ReadonlySet<string>,
): boolean {
  if (entry.surface !== 'site' && entry.surface !== 'app') return false;
  if (entry.config.navigation === 'document' || described.offline === 'network-only') return false;
  if (client.has(entry.surface)) return entry.config.navigation === 'prefetch';
  return (described.mode === 'static' || described.mode === 'isr') && !described.personal;
}

export interface PageSpeculation {
  /** The rendered `<script type="speculationrules">`, for `DocumentOptions.speculationHead`. */
  readonly head: string;
  /** The text between its tags — what a browser hashes. */
  readonly body: string;
  /** The `script-src` source that admits exactly that body. */
  readonly cspSource: string;
}

export interface PageSpeculationInput {
  readonly config: SpeculationConfig;
  /** `navigation.client`: the surfaces whose documents carry the router instead. */
  readonly client: readonly NavigationSurface[];
  readonly entries?: readonly RouteEntry[];
  readonly described?: readonly RouteDescriptor[];
  /**
   * The NON-default routed locales' URL segments — `otherLocaleSegments(appLocaleSet)`, the set the
   * manifest, the worker and the prerender read. Every caller passes it: no build reads the
   * ambient locale config.
   */
  readonly localeSegments: readonly string[];
}

/** Every routed locale but the default, as the URL segment a prefix is spelled in. */
export const otherLocaleSegments = (set: AppLocaleSet): readonly string[] => {
  const fallback = localeSegment(set.defaultLocale);
  return set.locales.map(localeSegment).filter((segment) => segment !== fallback);
};

/**
 * Tag and hash from ONE body, as `themeBoot` does. `undefined` when the app turned it off or no
 * page is a candidate — then no document carries a tag and the policy admits nothing new. Called
 * after the app is loaded: the route table and the routed locales are what it reads.
 */
export function pageSpeculation(input: PageSpeculationInput): PageSpeculation | undefined {
  if (input.config.prefetch === false) return undefined;
  const entries = input.entries ?? routeEntries();
  const described = new Map((input.described ?? describePages()).map((one) => [one.file, one]));
  const client = new Set<string>(input.client);
  const segments = input.localeSegments;
  const include = entries
    .filter((entry) => {
      const facts = described.get(entry.file);
      return facts !== undefined && speculationCandidate(entry, facts, client);
    })
    .map((entry) => speculationPattern(entry.path, segments));
  const body = speculationRulesBody({
    eagerness: input.config.prefetch,
    include,
    exclude: input.config.exclude,
  });
  if (body === undefined) return undefined;
  return {
    head: renderHead([speculationRulesTag(body)]),
    body,
    cspSource: cspHashSource(body),
  };
}
