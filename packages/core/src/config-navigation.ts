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
}

export interface NavigationSection {
  readonly navigation: NavigationConfig;
}

export interface NavigationSectionInput {
  readonly navigation?: { readonly client?: readonly NavigationSurface[] | undefined } | undefined;
}

/** A whole-value key: the last layer that listed surfaces wins, as `locales` does. */
export function mergeNavigation(layers: readonly NavigationSectionInput[]): NavigationSection {
  let client: readonly NavigationSurface[] = [];
  for (const layer of layers) {
    const said = layer.navigation?.client;
    if (said !== undefined) client = said;
  }
  return { navigation: { client } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function navigationIssues(config: NavigationSection, issues: string[]): void {
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
