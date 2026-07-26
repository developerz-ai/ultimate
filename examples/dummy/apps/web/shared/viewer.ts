/**
 * Who is looking, in the only two dimensions rendering cares about: language and clock.
 * `site/` builds one from the request (anonymous, prerendered per locale); `app/` builds one from
 * the member row. Both surfaces then pass the same shape down, so no component has to know which
 * one it is rendering for.
 */

import {
  type AppLocale,
  type AppZone,
  DEFAULT_LOCALE,
  DEFAULT_ZONE,
  isSupportedLocale,
  isSupportedZone,
} from '@postly/domain';

export type Viewer = {
  readonly locale: AppLocale;
  readonly zone: AppZone;
};

/**
 * Anonymous visitors have no member row, so the zone comes from a hint and falls back to UTC.
 * It is never guessed from the server's own clock — that is how a Berlin server tells a Sydney
 * reader the wrong day.
 */
export const anonymousViewer = (hint: {
  locale?: string | undefined;
  zone?: string | undefined;
}): Viewer => ({
  locale: hint.locale && isSupportedLocale(hint.locale) ? hint.locale : DEFAULT_LOCALE,
  zone: hint.zone && isSupportedZone(hint.zone) ? hint.zone : DEFAULT_ZONE,
});

export const viewerOf = (member: { locale: string; tz: string }): Viewer =>
  anonymousViewer({ locale: member.locale, zone: member.tz });
