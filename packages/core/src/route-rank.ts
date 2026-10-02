// Single responsibility: the ONE precedence between route patterns, as an integer. Tier 0 because
// three tier-4 readers need it and may not import each other — `@ultimat3/render`'s
// `compilePattern` (ISR, sitemap extras, the admin), and `@ultimat3/pwa`'s worker rule order.

/**
 * Per segment, how strongly it claims a pathname: a literal 3, a `:param` 2, a `*catch-all` 1, and
 * 4 where the pattern has already ENDED — `/` outranks `/*rest` and `/docs` outranks `/docs/*path`
 * at the bare prefix, as the request router's own terminal outranks its catch-all.
 */
const SEGMENT_WEIGHT = { literal: 3, param: 2, catchAll: 1, ended: 4 } as const;
const WEIGHT_BASE = 5;
/** 5^22 < 2^53: every rank is an exact integer. A deeper pattern ties past its 22nd segment. */
export const ROUTE_RANK_SEGMENTS = 22;

/**
 * The request router's precedence (`@ultimat3/http`'s trie) as ONE number, higher wins: segment by
 * segment, the first segment where two patterns differ decides — literal over `:param` over
 * `*catch-all`. Positional, never a sum: the 100/10/1 sum this replaced ranked `/:a/b/c` above
 * `/a/:x/:y` for `/a/b/c`, where the trie takes the literal first segment. Compare two ranks only
 * with each other; the value itself means nothing.
 */
export function routeRank(pattern: string): number {
  const weights = pattern
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith('*')) return SEGMENT_WEIGHT.catchAll;
      if (segment.startsWith(':')) return SEGMENT_WEIGHT.param;
      return SEGMENT_WEIGHT.literal;
    });
  let rank = 0;
  for (let i = 0; i < ROUTE_RANK_SEGMENTS; i += 1) {
    rank = rank * WEIGHT_BASE + (weights[i] ?? SEGMENT_WEIGHT.ended);
  }
  return rank;
}
