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
import { derivePath } from '@ultimat3/action';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import { DateTime, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { Api } from '../../api';
import { useActor } from '../../shared/actor';
import { Layout } from '../layout';
import styles from './page.module.scss';

/**
 * The action the editor posts to, named once and checked by the compiler, then derived into a
 * path. `savePreferences` → `POST /api/settings/save-preferences`, minted here and carried into
 * the browser as a prop: an island may not import `@ultimat3/action` (36 kB of `rpc()` in a
 * browser chunk), and it must not spell a URL of its own either.
 */
const SAVE_ACTION = 'savePreferences' satisfies keyof Api['actions'];

/**
 * The page's one island, declared ABOVE `defineRoute` so the route can drain it. `props` are the
 * exact keys the browser gets — JSON, already translated. `hydrate` is stated on the route below
 * rather than derived, because a settings form that waits for a click is a form whose first click
 * is spent waking it up.
 */
const Preferences = island({
  src: './settings.island.tsx',
  props: [
    'endpoint',
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
  /**
   * Measured, not guessed: a 17,807-byte island chunk plus the 774-byte `idle` hydration runtime
   * is 18,581 bytes on this document, against 20,480 — 1,899 bytes of headroom (re-measured
   * 2026-08-25: the chunk was 19,368 and the runtime 615 when this was first written, and both
   * moved with the tree rather than with this route). Most of it is the Solid runtime itself,
   * which is issue #254's subject; the editor's own compiled markup is the rest.
   *
   * Re-measure rather than adjust: `buildIslands` in `settings.island.test.ts` reports the chunk,
   * and `hydrateRuntimeBytes` reports the runtime.
   */
  budget: { js: '20kb', lcp: 1800 },
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
    <Layout>
      <Stack gap={6} class={styles.page}>
        <header>
          <h1>{t('app.settings.heading')}</h1>
          <Text tone="muted">{t('app.settings.intro')}</Text>
        </header>

        <div class={styles.editor}>
          <Preferences
            endpoint={derivePath(SAVE_ACTION).path}
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
