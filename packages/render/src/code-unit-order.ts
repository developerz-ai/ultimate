/**
 * The one string comparator this package orders derived output with.
 *
 * Package-internal on purpose: it is the ordering rule, not public API. Nothing outside
 * `@ultimat3/render` may need it, and a comparator on the barrel is a shape apps would depend on.
 */

/**
 * Compare by UTF-16 code unit — never `localeCompare`, which with no locale argument answers from
 * the runtime's ICU **default locale** and **collation version**: `'/A'` sorts after `'/a'` on one
 * machine and before it on the next, and `'/zoo'` before `'/ärzte'` under `sv-SE` but after it
 * under `en-US`, for the same input. Everything this package orders is either diffed across
 * deploys (`describeRoutes()` feeds `x.manifest.json`, the sitemap and `sw.js`'s rule table) or is
 * a choice a build makes (`pageComponentOf`'s fallback), so a machine-dependent order is a no-op
 * deploy that reads as a change — or a different page rendered per host. Same rule
 * `@ultimat3/pwa`'s `precache.ts` and `service-worker.ts` state for the artifact they emit.
 */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
