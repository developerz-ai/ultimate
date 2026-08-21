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
import type { JSX } from 'solid-js';
import { useActor } from '../shared/actor';
import { viewerOf } from '../shared/viewer';
import styles from './layout.module.scss';
import { UpdateBanner } from './update-banner';
import { ViewerProvider } from './viewer-context';

export function Layout(props: { readonly children: JSX.Element }): JSX.Element {
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
            No org switcher. `@postly/ui`'s `OrgSwitcher` posts a native form, and switching org
            is a SESSION write — a cookie plus a redirect — which none of the eight primitives can
            perform: an action answers JSON and may not touch headers or cookies, and an app
            cannot contribute a raw POST route (`packages/cli/src/serve.ts` composes actions,
            queries, assets, storage, islands and page routes, and nothing else). It posted to
            `/_x/session/org` until 2026-08, a path nothing in this repo has ever served.
          */}
          <nav class={styles.nav} aria-label={t('app.nav.org')}>
            <a href="/feed">{t('app.nav.feed')}</a>
            <a href="/settings">{t('app.nav.settings')}</a>
          </nav>
        </header>

        <UpdateBanner label={t('errors.updateAvailable')} action={t('errors.updateAction')} />

        <main class={styles.main}>{props.children}</main>
      </div>
    </ViewerProvider>
  );
}
