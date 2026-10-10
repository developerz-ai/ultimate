// What `x verify` says about an `isr` route that never declared the query it varies on. Advice and
// not a finding: the route works as it always did — it keys its stored pages on the whole query
// string — and that is exactly the problem a reader should hear about before a visitor finds it.

import { describePages } from '@ultimat3/render';

/**
 * One line per `isr` route with no `revalidate.query`. Such a route renders and stores a page for
 * every distinct query string it is asked for, so `?x=1`, `?x=2`, … evict its real pages from the
 * bounded store and cost a render each, and `utm_*` parameters split one page into many.
 */
export function isrQueryAdvice(): readonly string[] {
  return describePages()
    .filter((route) => route.mode === 'isr' && (route.revalidateQuery ?? null) === null)
    .map(
      (route) =>
        `${route.file}: render 'isr' with no revalidate.query — its stored pages are keyed on the whole query string, so any visitor can mint one per request. Declare revalidate: { query: [] } (or the parameters the page varies on)`,
    );
}
