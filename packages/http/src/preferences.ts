// `ctx.locale`, `ctx.tz` and `content-language` for one request: the `locale` stage calls this,
// and `auth` calls it again once the actor's saved preference is known. WHERE each value is read
// from is this file's; what a locale or a zone IS stays `@ultimat3/i18n`'s and `@ultimat3/time`'s.

import { resolveTimeZone } from '@ultimat3/time';
import type { HttpConfig } from './config';
import type { RequestContext } from './context';
import { readCookie } from './locale';
import { requestLocale } from './locale-prefix';
import type { UltimateRequest } from './request';

/**
 * `ctx.locale`, `ctx.tz` and `content-language` from every source the request carries — the
 * cookie, the header and, once `auth` has run, the actor's saved preference. One function for both
 * stages, so the order is always the owners' (`resolveLocale`, `resolveTimeZone`) and never this
 * file's.
 */
export function resolvePreferences(
  request: UltimateRequest,
  ctx: RequestContext,
  config: HttpConfig,
): void {
  const cookies = request.header('cookie');
  ctx.locale = requestLocale(ctx, {
    // Documented as a source and never read until 2026-09: an email preview link's `?locale=es`
    // rendered in the visitor's cookie locale. The ORDER stays `resolveLocale`'s.
    query: ctx.url.searchParams.get('locale'),
    header: request.header('accept-language'),
    cookie: readCookie(cookies, config.locale.cookie),
    user: ctx.actor.locale,
  });
  ctx.tz = resolveTimeZone({
    cookie: readCookie(cookies, config.tz.cookie),
    header: request.header(config.tz.header),
    user: ctx.actor.tz ?? null,
  }).zone;
  ctx.headers.set('content-language', ctx.locale);
}
