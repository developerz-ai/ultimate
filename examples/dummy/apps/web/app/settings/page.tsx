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
import { DateTime, DescriptionList, Stack, Text, uiCatalog } from '@ultimat3/ui';
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
    'ui',
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
   * raised 59kb → 60kb, measured 60,437 B (2026-10-05, plan 101 sweep 2; the reference-app gate's
   * `x build --target static`): +90 B for the client-side action error registry, which now carries
   * `X_IDEMPOTENT_REPLAY_REDACTED` (#591) so a refused replay renders its own title and fix.
   * raised 60kb → 61kb (plan 101 sweep 9). measured: 61,494 B (2026-10-05;
   * `x build --target static`), against 62,464. why: +59 B in the inline `idle` runtime — `catchUp`
   * lets go of a press after a mount it did not flush (a held island's first click ran twice, #506);
   * the other +998 B is the settings island's growth from the rest of sweep 9, measured here.
   * raised 61kb → 67kb (26.1.0). measured: 67,874 B (2026-10-08; `x build --target static`),
   * against 68,608. why: the client router grew 19,966 → 24,058 B (+4,092) — `navigation: 'modal'`,
   * a hash-addressed `<dialog>` over the page, and `refresh`/`openModal`/`closeModal` for
   * navigating from code — charged to every `app/` document; and the settings island grew
   * 39,182 → 41,294 B (+2,112) for its Web Push button: `@ultimat3/pwa/client`'s
   * `subscribeToPush`, the `subscribePush` action through the typed client, and the status line
   * that tells a failed save from a browser that cannot (`push-status.ts`). The other +176 B is
   * main's growth between the 2026-10-05 measurement and 26.0.0, which measured 61,670 B (router
   * 19,966, island 39,182, banner 710, inline runtime 1,812), unstated until now.
   * raised 67kb → 67.5kb (#710, owner decision 19). measured: 68,644 B (2026-10-09;
   * `x build --target static`), against 69,120; main measured 67,945 the same way. why: +699 B
   * settings island — core's `reviveWireDates` in the transport its typed action client sends
   * through, so a read's `Date` reaches a caller as a `Date`.
   * raised 67.5kb → 71kb (29.1.0). measured: 72,473 B (2026-10-29; `x build --target static`),
   * against 72,704. why: the client router grew 24,448 → 27,845 B (+3,397) — a route modal
   * opens on the click as a busy frame its document then fills (`ultimate-modals`, the frame,
   * aborting on close), opened with `show()` + `showPopover()` instead of `showModal()` and so
   * keeping focus, Tab and Escape itself; charged to every `app/` document, as the router is.
   * All of the +3,397 B over main's 69,076 B.
   */
  // measured: 72807 B (x build --target static) — why: a remote error carries the server's
  // `requestId` (core's `withRequestId`, in the transport this island sends through) — raised
  // 71kb → 72kb (30.0.0): settings island + inline runtime +370, the client router −36.
  // measured: 74051 B (2026-11-03; x build --target static, against main's 72,807) — why:
  // core's shared refusal-title table gained wave 3's 12 codes (`X_OUTBOUND_*`, `X_BREAKER_OPEN`,
  // `X_ERROR_DECLARATION_INVALID`, `X_SCHEMA_SENSITIVE_OUTPUT`: 878 B of titles), so a refusal
  // with one of them reaching the island is still titled, and a refusal's issues carry the `rule` and `params` a form translates
  // on (plan 101 slice 10) — raised 72kb → 72.5kb (30.0.0): settings island +1,244 B.
  // measured: 77774 B (2026-11-05; x build --target static, against main's 74,107) — why: the
  // settings island +2,258 B: `action.client()` filling a pinned URL (`action/client.ts` +536,
  // `errors-http.ts` 443, `route-path-template.ts` 385), 5a's titles (+499) and the session flag
  // (+392); the client router +1,409 B: `refresh()` keeps the same visitor's focus
  // (`navigation-refresh.ts`, `markFocus`/`restoreFocus`), never aborts a click in flight and is
  // asked its hold again at the swap — raised 72.5kb → 76kb (30.0.0).
  // measured: 79561 B (2026-11-05; x build --target static, against wave 5a's 77,774) — why: the
  // client router +327 B: a navigation given up at `NAVIGATION_TIMEOUT_MS`
  // (`navigation-deadline.ts`) and a timed-out `refresh()` that fails quietly
  // (`navigation-refresh.ts`); the settings island +1,460 B: `rpc()` reading the server-stamped
  // path pins read from `<meta name="ultimate-pins">` (`client-paths-pins.ts`) and filled by
  // `fill-wire.ts`, which refuses a `.`/`..` segment — raised 76kb → 78kb (30.0.0, plan 101 wave
  // 5b).
  // measured: 80803 B (2026-11-06; x build --target static, against 79,601) — why:
  // `/x-client-vitals.js` +1,202 B, real-user timings beaconed on hide (`clientErrors.vitals`,
  // `app/` only) — raised 78kb → 79.5kb (plan 101, 41).
  // measured: 83136 B (2026-11-06; `x verify --only budgets`, against 80,803) — why: the
  // settings island's `rpc` +2,065 B, every typed-client method carrying `.stream(input)` (core's
  // `clientStream`, plan 101 slice 41); the rest is the inline runtime — raised 79.5kb → 82kb.
  // measured: 106936 B (2026-11-06; `x verify --only budgets`, against 83,136) — why: the time
  // zone is `@ultimat3/ui`'s SearchableSelect (plan 101, 23-ui-searchable-select): a searchable,
  // grouped, keyboard-only listbox posting the zone id, never typed text, under `UiProvider` with
  // the server-resolved `ui.*` strings — settings island 51,4xx → 73,489 B (+~22.0 kB); the client
  // router 27,845 → 29,570 B (+1,725) is wave 10's navigation work, charged to every `app/`
  // document — raised 82kb → 105kb.
  // measured: 106833 B (2026-11-06; x build --target static, against 107,327) — why: the theme
  // is a segmented `Radio` (three native radios in one strip, every choice visible, one tap
  // each) where a `<select>` hid two of three, +1,584 B; ui's keys tree-shaken per key
  // (`ui-keys.ts`), −2,078 B; the island 73,880 → 73,386 B — lowered 105kb → 104.5kb (plan 101
  // wave 10, 38-ui-pickers).
  // measured: 107593 B (2026-11-07, sweep 2; x build --target static) — why: the record envelope's `order` decode in the transport (sweep 2). Sweep 1, 107446 B: the island 73,386 → 73,816
  // (core's `clientStream` sharing `call()`'s unwrap) and the router +122 B.
  budget: { js: '106kb' },
  meta: ({ t }) => ({ title: t('app.settings.metaTitle'), robots: { index: false } }),
});

export function Page(): JSX.Element {
  const t = useT();
  const actor = useActor();
  const member = actor.member;

  /** Identifiers, not prose: a zone and a BCP-47 tag are the same in every locale. */
  const identity = (value: string): { value: string; label: string } => ({ value, label: value });

  /**
   * A zone as the searchable list shows it: the city to read, its region to group by, the whole
   * IANA id beside it — and posted. Still identifiers, so no `t()`: `Europe/Madrid` is `Madrid`
   * under `Europe` in every locale.
   */
  const zoneOption = (zone: string) => {
    const [region = '', ...rest] = zone.split('/');
    const city = rest.join('/').replaceAll('_', ' ');
    return city === ''
      ? { value: zone, label: zone }
      : { value: zone, label: city, group: region, description: zone, keywords: [zone] };
  };

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
    <Layout banner={Banner} here="/settings">
      <Stack gap={6} class={styles.page}>
        <header>
          <h1>{t('app.settings.heading')}</h1>
          {/* A `select` family: one sentence per role, so each locale words its own grammar. */}
          <Text>{t('app.settings.role', { select: member.role, org: actor.org.name })}</Text>
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
            timezones={SUPPORTED_ZONES.map(zoneOption)}
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
              push: t('app.settings.pushLabel'),
              pushOn: t('app.settings.pushOn'),
              pushDenied: t('app.settings.pushDenied'),
              pushUnavailable: t('app.settings.pushUnavailable'),
            }}
            ui={uiCatalog(t)}
          >
            {/*
              The island's shell: what the SERVER knows, which is the saved row. It is on screen
              before the chunk loads and it is what a member with no JavaScript reads — `app/` is
              the surface that assumes a browser (a 14 kB JS baseline), so the editing half is the
              island's and this half never pretends to be a form.
            */}
            <DescriptionList
              class={styles.summary}
              items={[
                { term: t('app.settings.localeLabel'), detail: member.locale },
                {
                  term: t('app.settings.timezoneLabel'),
                  detail: [
                    `${member.tz} — `,
                    <DateTime value={actor.now} timeZone={member.tz} dateStyle="long" />,
                  ],
                },
                { term: t('app.settings.themeLabel'), detail: themeLabel[member.theme] },
              ]}
            />
          </Preferences>
        </div>
      </Stack>
    </Layout>
  );
}
