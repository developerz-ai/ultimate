/**
 * A route pattern (`/docs/:id`, `/docs/*path`) as the regex a pathname is tested with, and the
 * order two matching patterns are ranked in. Split from `registry.ts`, which registers routes; this
 * file only reads a pattern string.
 */

import { literalSegmentPattern, routeRank } from '@ultimat3/core';

export interface CompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
  readonly keys: readonly string[];
  /**
   * Higher wins when two patterns match the same pathname — `@ultimat3/core`'s `routeRank`, the
   * ONE ordering rule: ISR, the sitemap, the admin and `@ultimat3/pwa`'s worker all sort on it.
   */
  readonly specificity: number;
}

export function compilePattern(path: string): CompiledPattern {
  const keys: string[] = [];
  const segments = path.split('/').filter((s) => s.length > 0);

  // Each part carries its own leading `/`, so a catch-all can own its separator: an empty rest is
  // the bare prefix (`/docs`), which is the path `static-path.ts` writes for it.
  const parts = segments.map((segment) => {
    if (segment.startsWith('*')) {
      keys.push(segment.slice(1));
      return '(?:/(.*))?';
    }
    if (segment.startsWith(':')) {
      keys.push(segment.slice(1));
      return '/([^/]+)';
    }
    return `/${literalSegmentPattern(segment)}`;
  });

  return {
    source: path,
    regex: new RegExp(`^${parts.join('')}/?$`),
    keys,
    specificity: routeRank(path),
  };
}
