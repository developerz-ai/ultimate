/**
 * The cache-tag vocabulary, re-exported for the surfaces that may not reach into `@postly/db`
 * directly. `site/` routes read `tag.blog` / `tag.plan` to declare their ISR revalidation set —
 * that is not a database read, but `@postly/db` is still the database boundary from a route's
 * point of view, so the indirection through `shared/` (a leaf `app/`, `site/` and `api/` may all
 * import) is what keeps `X_BOUNDARY_ROUTE_TO_DB` about routes touching rows, not about the one
 * value every route already needs.
 */

export { tag } from '@postly/db';
