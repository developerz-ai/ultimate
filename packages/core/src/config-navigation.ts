// Single responsibility: the `navigation` block of `app.config.ts` — which surfaces move between
// their pages by client-side navigation over server-rendered documents (`@ultimat3/render`'s
// `navigation.ts`), and the boot-time refusal of a surface that has no pages to navigate between.
//
// Split out of `config.ts` at its 500-line ceiling, the way `config-site.ts` and `config-pwa.ts`
// were: shape, merge and screen are one subject.

import { describeValue } from './error-render';

/**
 * The surfaces that render documents a browser navigates between. `api` answers JSON and `shared`
 * renders nothing, so neither can opt in — and `navigation: { client: ['api'] }` is refused rather
 * than accepted and ignored.
 */
export const NAVIGATION_SURFACES = ['site', 'app'] as const;
export type NavigationSurface = (typeof NAVIGATION_SURFACES)[number];

/**
 * `client` lists the surfaces whose same-surface links and forms are followed by the client
 * router: it fetches the next document, swaps it in, and keeps the tab's islands, sockets and
 * scroll state alive. EMPTY BY DEFAULT — every navigation is a full document load, and a surface
 * that does not opt in ships no router byte (axiom 6: a `site/` page stays 0kb).
 */
export interface NavigationConfig {
  readonly client: readonly NavigationSurface[];
  readonly speculation: SpeculationConfig;
}

/**
 * How eagerly a browser may fetch a link's document before the click, on a page that carries no
 * client router. `'moderate'`: on pointer rest or pointer down. `'conservative'`: on pointer down
 * only. `'eager'` and `'immediate'` are not offered — they fetch links nobody pointed at.
 */
export const SPECULATION_EAGERNESS = ['moderate', 'conservative'] as const;
export type SpeculationEagerness = (typeof SPECULATION_EAGERNESS)[number];

/**
 * Speculation Rules (`<script type="speculationrules">`) for the documents a browser navigates
 * between WITHOUT the client router — the 0kb answer to a slow full-page load. PREFETCH only, never
 * prerender: a prefetch runs no script of the next page, so no analytics hit and no island boots
 * for a page nobody opened. ON BY DEFAULT at `'moderate'`; `prefetch: false` emits nothing.
 *
 * Only pages the route table knows to be a pure read are candidates (`@ultimat3/cli`'s
 * `page-speculation.ts`); `exclude` removes more, as URL patterns (`/blog/*`, `/legal/:doc`).
 */
export interface SpeculationConfig {
  readonly prefetch: SpeculationEagerness | false;
  readonly exclude: readonly string[];
}

export const DEFAULT_SPECULATION: SpeculationConfig = Object.freeze({
  prefetch: 'moderate',
  exclude: Object.freeze([]) as readonly string[],
});

export interface NavigationSection {
  readonly navigation: NavigationConfig;
}

export interface NavigationSectionInput {
  readonly navigation?:
    | {
        readonly client?: readonly NavigationSurface[] | undefined;
        readonly speculation?:
          | {
              readonly prefetch?: SpeculationEagerness | false | undefined;
              readonly exclude?: readonly string[] | undefined;
            }
          | undefined;
      }
    | undefined;
}

/**
 * Whole-value keys: the last layer that listed surfaces wins, as `locales` does — and so does the
 * last one that set `speculation.prefetch` or listed `speculation.exclude`, each on its own.
 */
export function mergeNavigation(layers: readonly NavigationSectionInput[]): NavigationSection {
  let client: readonly NavigationSurface[] = [];
  let prefetch: SpeculationEagerness | false = DEFAULT_SPECULATION.prefetch;
  let exclude: readonly string[] = DEFAULT_SPECULATION.exclude;
  for (const layer of layers) {
    const said = layer.navigation?.client;
    if (said !== undefined) client = said;
    const speculation = layer.navigation?.speculation;
    if (speculation?.prefetch !== undefined) prefetch = speculation.prefetch;
    if (speculation?.exclude !== undefined) exclude = speculation.exclude;
  }
  return { navigation: { client, speculation: { prefetch, exclude } } };
}

/**
 * A pattern is emitted inside a JSON string the browser parses as a URL pattern: it must be a
 * same-origin PATH, so anything not starting with `/` (a host, a scheme, `*`) is refused.
 */
function speculationIssues(speculation: unknown, issues: string[]): void {
  if (typeof speculation !== 'object' || speculation === null) {
    issues.push(`navigation.speculation must be an object, not ${describeValue(speculation)}`);
    return;
  }
  const { prefetch, exclude } = speculation as { prefetch?: unknown; exclude?: unknown };
  if (prefetch !== false && !SPECULATION_EAGERNESS.some((known) => known === prefetch)) {
    issues.push(
      `navigation.speculation.prefetch must be ${SPECULATION_EAGERNESS.join(', ')} or false, not ${describeValue(prefetch)}`,
    );
  }
  if (!Array.isArray(exclude)) {
    issues.push(
      `navigation.speculation.exclude must be a list of URL patterns, not ${describeValue(exclude)}`,
    );
    return;
  }
  for (const pattern of exclude as readonly unknown[]) {
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
      issues.push(
        `navigation.speculation.exclude contains ${describeValue(pattern)}, not a path pattern starting with "/"`,
      );
    }
  }
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function navigationIssues(config: NavigationSection, issues: string[]): void {
  speculationIssues(config.navigation.speculation, issues);
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const client: unknown = config.navigation.client;
  if (!Array.isArray(client)) {
    issues.push(`navigation.client must be a list of surfaces, not ${describeValue(client)}`);
    return;
  }
  const seen = new Set<unknown>();
  for (const surface of client as readonly unknown[]) {
    if (!NAVIGATION_SURFACES.some((known) => known === surface)) {
      // A string is a surface name worth echoing; anything else goes through `describeValue`.
      const said = typeof surface === 'string' ? `"${surface}"` : describeValue(surface);
      issues.push(
        `navigation.client contains ${said}, not one of ${NAVIGATION_SURFACES.join(', ')}`,
      );
    } else if (seen.has(surface)) {
      issues.push(`navigation.client lists "${String(surface)}" twice`);
    }
    seen.add(surface);
  }
}
