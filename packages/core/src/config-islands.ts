// Single responsibility: the `islands` block of `app.config.ts` — how the build bundles the app's
// `*.island.tsx` client entries (`@ultimat3/cli`'s `island-bundle.ts`). Its own file for the
// reason `config-navigation.ts` is: shape, merge and screen are one subject, and `config.ts` is at
// its 500-line ceiling.

import { describeValue } from './error-render';

/**
 * `sharedChunks: true` builds every island in ONE split bundle, so a module two islands import is
 * one shared chunk a page fetches once and a browser caches across pages. OFF BY DEFAULT, and the
 * reason is measured rather than cautious: tree shaking across one split build keeps whatever ANY
 * importer uses, so an island that imports one helper from a module other islands use heavily
 * pays for all of it. `examples/dummy`'s plain-DOM update banner went 712 → 16,288 B with it on;
 * notificado.co's `/afiliados` with two upload islands went 55,585 → 42,331 B. Turn it on where a
 * surface's pages render many islands over one graph, and weigh the routes with `x verify`.
 */
export interface IslandsConfig {
  readonly sharedChunks: boolean;
}

export interface IslandsSection {
  readonly islands: IslandsConfig;
}

export interface IslandsSectionInput {
  readonly islands?: { readonly sharedChunks?: boolean | undefined } | undefined;
}

/** The last layer that said it wins, as every scalar does. */
export function mergeIslands(layers: readonly IslandsSectionInput[]): IslandsSection {
  let sharedChunks = false;
  for (const layer of layers) {
    const said = layer.islands?.sharedChunks;
    if (said !== undefined) sharedChunks = said;
  }
  return { islands: { sharedChunks } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function islandsIssues(config: IslandsSection, issues: string[]): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const said: unknown = config.islands.sharedChunks;
  if (typeof said !== 'boolean') {
    issues.push(`islands.sharedChunks must be true or false, not ${describeValue(said)}`);
  }
}
