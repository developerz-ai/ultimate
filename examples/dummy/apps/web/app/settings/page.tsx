/**
 * Preferences. `ssr` because the values on screen are the acting member's own row: there is
 * nothing here to cache and nothing to stream — one render, per request, behind the route's gate.
 *
 * All four pickers write to the **member row**, not to localStorage. That is what makes the digest
 * email, the admin dashboard and a future mobile client agree with this screen. The server renders
 * what is SAVED; `settings.island.tsx` is the editor, and it is the only module this route ships.
 */

import type { AppTheme } from '@postly/domain';
import { SUPPORTED_LOCALES, SUPPORTED_ZONES, THEMES } from '@postly/domain';
import { useT } from '@postly/i18n';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import { DateTime, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useActor } from '../../shared/actor';
import { Layout, updateBannerIsland } from '../layout';
import styles from './page.module.scss';

/**
 * The page's one island, declared ABOVE `defineRoute` so the route can drain it. `props` are the
 * exact keys the browser gets — JSON, already translated. `hydrate` is stated on the route below
 * rather than derived, because a settings form that waits for a click is a form whose first click
 * is spent waking it up.
 */
const Preferences = island({
  src: './settings.island.tsx',
  props: [
    'nowIso',
    'locale',
    'timezone',
    'theme',
    'digestOptIn',
    'locales',
    'timezones',
    'themes',
    'labels',
  ],
});

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../update-banner.island.tsx');

export const config = defineRoute({
  render: 'ssr',
  /**
   * A `RouteGuard` is a PERMISSION and not a `Policy` (`packages/render/src/route.ts`): render
   * only needs to know the route has a gate, so that evaluation stays in one place. `member:self`
   * is the same grant `savePreferences` gates on; the row-level half, "your own member row",
   * stays in `memberSelf` where the action evaluates it.
   */
  policy: { permission: 'member:self' satisfies KnownPermission },
  /** Never precached: this document is one member's own row, and a shared cache entry is a leak. */
  offline: 'runtime',
  hydrate: 'idle',
  // Fetched on hover as well as on click: this page's GET only renders — it records nothing, so a
  // guess that never becomes a visit costs one read. The server refuses a prefetch of any page
  // that does not say this (`@ultimat3/http`'s navigation gate).
  navigation: 'prefetch',
  /**
   * measured: 39,416 B (2026-09-22; `buildIslands`, `hydrateRuntimeBytes`) — the island chunk
   * 36,960 + the update banner 712 + the `idle` runtime 1,744, against 39,936. No page boot: it
   * renders only on a page with a realtime island, and this one holds none.
   * Counted the way the `budgets` step sums a document (`packages/cli/src/budgets.ts`): every
   * executable `<script src>` it carries — the page boot included, only `/x-sw-register.js` is
   * exempt (`FRAMEWORK_SCRIPTS`) — plus every island chunk and the inline hydration runtime.
   * why: the save goes through the typed client and core's one transport (plan 101) — a raw
   * `fetch` was the 17.8 kB this budget used to hold, and it bypassed the page store, the
   * idempotency header and the principal fence every other write takes. Most of the growth is the
   * transport's error registry and trace headers, where shrinking belongs. +712 B for the layout's
   * update banner, which could never appear while it was a server component.
   *
   * measured: 40,047 B (2026-09-27; `x build --target static`'s `.x/build-stats.json`), against
   * 40,140 (`39.2kb`).
   * why: the typed client's own growth, the same bytes `/pricing` states: the `'readable'` action
   * path style and three new error titles in `@ultimat3/action`'s registry.
   *
   * measured: 58,644 B (2026-09-28; `x build --target static`'s `.x/build-stats.json`), against
   * 58,880 (`57.5kb`).
   * why: client navigation (`navigation: { client: ['app'] }` in `app.config.ts`) — the router,
   * `/_x/navigation/<hash>.js`, 18,276 B on every `app/` document, charged like the page boot: it
   * is interactivity this app opted into, and a route cannot remove it. +247 B in the islands: the runtime's once-per-root visit (40) and core's
   * transport announcing every write (`onClientWrite`), which is what empties the router's cache.
   *
   * measured: 59,439 B (2026-09-28; `x build --target static`'s `.x/build-stats.json`), against
   * 59,904 (`58.5kb`).
   * why: the router's input fixes (22.8.1) — a click the view transition aimed at `<html>` is given
   * to the element under the pointer, a press skips the running transition, and a press or click
   * cancels the pending prefetch, so a fast click sends one request, not two (+795 B).
   *
   * measured: 60,347 B (2026-10-02; `x build --target static`'s `budgets` step), against 60,416
   * (`59kb`).
   * why: the router's plan-101 slice 09 fixes (+774 B, router 19,269 → 20,043 B) — a reload or a
   * Back after a full load lands where the visitor left, the channel closes on `pagehide` so the
   * page can enter the back/forward cache, a form's line breaks go as CRLF, an aborted navigation's
   * sheets are retired, a finished older view transition no longer forgets the running one, and
   * `<a href="#">` and an unparsable href stay the browser's. The other +198 B is the router's
   * growth on main between 22.8.1's statement and this slice (19,071 → 19,269 B), unstated until now.
   */
  budget: { js: '59kb' },
  meta: ({ t }) => ({ title: t('app.settings.metaTitle'), robots: { index: false } }),
});

export function Page(): JSX.Element {
  const t = useT();
  const actor = useActor();
  const member = actor.member;

  /** Identifiers, not prose: a zone and a BCP-47 tag are the same in every locale. */
  const identity = (value: string): { value: string; label: string } => ({ value, label: value });

  /**
   * Every theme's label, resolved once. A record over `AppTheme` rather than a ternary at each of
   * the two call sites: adding a fourth theme is a compile error here instead of a silent gap.
   * Written out as three literal calls because `x i18n check` reads the SOURCE: a key reached
   * only through a lookup — the translator handed `KEYS[value]` — lands on the audit's `unused`
   * list, which is its "safe to delete" half. All three were on it while this file used one.
   */
  const themeLabel: Record<AppTheme, string> = {
    system: t('app.settings.themeSystem'),
    light: t('app.settings.themeLight'),
    dark: t('app.settings.themeDark'),
  };

  return (
    <Layout banner={Banner}>
      <Stack gap={6} class={styles.page}>
        <header>
          <h1>{t('app.settings.heading')}</h1>
          <Text tone="muted">{t('app.settings.intro')}</Text>
        </header>

        <div class={styles.editor}>
          <Preferences
            nowIso={actor.now.toISOString()}
            locale={member.locale}
            timezone={member.tz}
            theme={member.theme}
            digestOptIn={member.digestOptIn}
            locales={SUPPORTED_LOCALES.map(identity)}
            timezones={SUPPORTED_ZONES.map(identity)}
            themes={THEMES.map((value) => ({ value, label: themeLabel[value] }))}
            labels={{
              locale: t('app.settings.localeLabel'),
              localeHelp: t('app.settings.localeHelp'),
              timezone: t('app.settings.timezoneLabel'),
              timezoneHelp: t('app.settings.timezoneHelp'),
              theme: t('app.settings.themeLabel'),
              digest: t('app.settings.digestLabel'),
              digestHelp: t('app.settings.digestHelp'),
              save: t('common.save'),
              saved: t('common.saved'),
              retry: t('common.retry'),
            }}
          >
            {/*
              The island's shell: what the SERVER knows, which is the saved row. It is on screen
              before the chunk loads and it is what a member with no JavaScript reads — `app/` is
              the surface that assumes a browser (a 14 kB JS baseline), so the editing half is the
              island's and this half never pretends to be a form.
            */}
            <dl class={styles.summary}>
              <dt>{t('app.settings.localeLabel')}</dt>
              <dd>{member.locale}</dd>

              <dt>{t('app.settings.timezoneLabel')}</dt>
              <dd>
                {member.tz} — <DateTime value={actor.now} timeZone={member.tz} dateStyle="long" />
              </dd>

              <dt>{t('app.settings.themeLabel')}</dt>
              <dd>{themeLabel[member.theme]}</dd>
            </dl>
          </Preferences>
        </div>
      </Stack>
    </Layout>
  );
}
