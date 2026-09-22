/**
 * The authed shell. Flushed in the first streaming chunk, so it must not await anything: the
 * actor and their org come from the request context the framework already resolved.
 *
 * It establishes the viewer (locale + zone) every page below reads, and nothing else.
 *
 * **No `<UiProvider>` here.** It threw `X_UI_RUNTIME_MISSING` on every render of this shell — a
 * Provider needs a reactive owner and a server render has none, so its values would have reached no
 * descendant even if it had rendered. `useUi()` reads the locale and the zone off the request
 * context instead; a provider belongs inside a `*.island.tsx`, under the `mount()` that registered
 * a runtime. The member's `theme` went with it: `UiProvider` only ever wrote `data-theme` from a
 * client effect, so this shell never set the attribute its own header claimed it did.
 */

import { useT } from '@postly/i18n';
import { derivePath } from '@ultimat3/action';
import { type IslandComponent, island } from '@ultimat3/render';
import type { JSX } from 'solid-js';
import type { Api } from '../api';
import { useActor } from '../shared/actor';
import { viewerOf } from '../shared/viewer';
import styles from './layout.module.scss';
import { ViewerProvider } from './viewer-context';

/** `endSession` → `POST /api/sessions/end`, derived — `app/auth/actions.ts` sets the cookie. */
const SIGN_OUT_ENDPOINT = derivePath('endSession' satisfies keyof Api['actions']).path;

const BANNER_PROPS = ['label', 'action'] as const;

/** The update banner as a page declares it — `app/update-banner.island.tsx`. */
export type UpdateBannerIsland = IslandComponent<typeof BANNER_PROPS>;

/**
 * Declare the update banner on a page: call it at the PAGE's module scope, above `defineRoute`,
 * with the island's path relative to that page. An `island()` belongs to the route whose
 * `defineRoute` drains it (`@ultimat3/render`'s `island.ts`), and this module is evaluated once
 * for every page — a call here would hand the banner to whichever route loaded first.
 */
export const updateBannerIsland = (src: string): UpdateBannerIsland =>
  island({ src, props: BANNER_PROPS });

export function Layout(props: {
  readonly children: JSX.Element;
  /** This page's `updateBannerIsland(...)`. */
  readonly banner: UpdateBannerIsland;
}): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = () => viewerOf(actor.member);

  return (
    <ViewerProvider value={viewer()}>
      <div class={styles.shell}>
        <header class={styles.bar}>
          <a class={styles.brand} href="/feed">
            {t('common.appName')}
          </a>

          {/*
            No org switcher yet. `@postly/ui`'s `OrgSwitcher` posts a native form to a path nothing
            serves (`/_x/session/org`, until 2026-08). A session write IS an action's to make —
            `app/auth/actions.ts`' sign-out below sets its cookie on `ctx.headers` — so switching
            org is the same shape, one more action, when an org switcher earns its place.
          */}
          <nav class={styles.nav} aria-label={t('app.nav.org')}>
            <a href="/feed">{t('app.nav.feed')}</a>
            <a href="/settings">{t('app.nav.settings')}</a>
          </nav>

          {/* A native form: it works with scripting off, and the redirect is the full navigation
              the page's realtime rescopes on. */}
          <form method="post" action={SIGN_OUT_ENDPOINT} class={styles.signOut}>
            <button type="submit">{t('common.signOut')}</button>
          </form>
        </header>

        <props.banner label={t('errors.updateAvailable')} action={t('errors.updateAction')} />

        <main class={styles.main}>{props.children}</main>
      </div>
    </ViewerProvider>
  );
}
