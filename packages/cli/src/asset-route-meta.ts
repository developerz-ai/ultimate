// The one place an asset route's tag and rate-limit bucket are written. Every route serving built
// bytes (chunks, stylesheets, icons, site files, framework scripts) spends `assets`, not `default`:
// one page load is dozens of content-hashed GETs, and `default`'s 120 burst at 2/s answered 429 to
// an office behind one NAT from the fifth route on.

import type { RouteMeta } from '@ultimat3/http';

/** The tag `withRetainedAssets` and the manifest read to know a route serves built bytes. */
export const ASSET_ROUTE_TAG = 'assets';

/** The bucket in `@ultimat3/http`'s `DEFAULT_RATE_LIMIT` an asset route spends. */
export const ASSET_RATE_LIMIT_BUCKET = 'assets';

/** What an asset route declares itself; the tag and the bucket are this function's to write. */
export type AssetRouteDeclaration = Omit<
  RouteMeta,
  'tags' | 'rateLimit' | 'rateLimitBucket' | 'rateLimitedBy'
>;

/**
 * A route meta with `tags: ['assets']` and `rateLimit: 'assets'` written for it. Not optional per
 * route: `asset-route-meta.test.ts` walks the reference app's built table and refuses any
 * `assets.*` route whose meta did not come through here.
 */
export const assetRouteMeta = (meta: AssetRouteDeclaration): RouteMeta => ({
  ...meta,
  tags: [ASSET_ROUTE_TAG],
  rateLimit: ASSET_RATE_LIMIT_BUCKET,
});
