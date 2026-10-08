/**
 * The editor. A native `<form>` posting to the action's generated route, so it works before
 * hydration, with JavaScript disabled, and from the offline fallback's queue. There is no
 * client-side form library, because there is nothing here a browser does not already do.
 */

import { TITLE_MAX } from '@postly/domain';
import { useT } from '@postly/i18n';
import { derivePath } from '@ultimat3/action';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute } from '@ultimat3/render';
import { Button, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { Api } from '../../../api';
import { Layout, updateBannerIsland } from '../../layout';
import styles from './page.module.scss';

/**
 * The action this form posts to, named once and checked by the compiler — the same rule
 * `site/pricing/page.tsx` follows. `satisfies` is what makes the string safe: a renamed action is
 * a build error here, and `import type` keeps the runtime edge from `app/` into `api/` absent.
 *
 * `createPost` → `POST /api/posts/create`. Derived, never spelled out: this file said
 * `/_x/action/create-post` until 2026-08, which `derivePath` has never minted and nothing mounts.
 */
const CREATE_ACTION = 'createPost' satisfies keyof Api['actions'];
const CREATE_ENDPOINT = derivePath(CREATE_ACTION).path;

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../../update-banner.island.tsx');

export const config = defineRoute({
  render: 'ssr',
  offline: 'runtime',
  /**
   * Authoring is behind a grant, and the route has to say so: a page with no `policy` is declared
   * `auth: 'public'` (`packages/cli/src/runtime-render.ts`'s `metaOf`), which also drops `vary: cookie`
   * off the response. The row-level half stays with `createPost`'s own `postCreate`.
   */
  policy: { permission: 'post:create' satisfies KnownPermission },
  /**
   * The editor opens OVER the feed it was reached from (`/feed#/posts/new`): the feed's islands,
   * socket and scroll stay live underneath, and Escape, Back or Cancel close it. A full load of
   * `/posts/new` — a reload without the router, scripting off, a bookmark of the bare path — is
   * still this whole page; the server renders one document either way.
   */
  navigation: 'modal',
  /**
   * `idle`, for the layout's update banner alone: the form itself is the browser's, but an editor
   * left open across a deploy is exactly the page that must hear a new build is live.
   */
  hydrate: 'idle',
  /**
   * measured: 2,456 B (2026-09-22; `buildIslands`, `hydrateRuntimeBytes`) — the update banner
   * 712 + the `idle` runtime 1,744, against 3,072. No page boot: no realtime island renders here.
   * why: the update banner (`app/update-banner.island.tsx`) — plain DOM, the service worker's
   * announcement, no realtime and no page boot, and `@ultimat3/core/page` for the two names it
   * shares with the worker and the render. It was 0 while the banner was a server component that
   * could never appear.
   *
   * measured: 20,741 B (2026-09-28; `x build --target static`'s `.x/build-stats.json`), against
   * 20,992 (`20.5kb`).
   * why: client navigation (`navigation: { client: ['app'] }` in `app.config.ts`) — the router,
   * `/_x/navigation/<hash>.js`, 18,276 B on every `app/` document, charged like the page boot: it
   * is interactivity this app opted into, and a route cannot remove it. +40 B in the `idle` runtime, which now visits each island root once
   * so it can re-run over a swapped-in body.
   *
   * measured: 21,536 B (2026-09-28; `x build --target static`'s `.x/build-stats.json`), against
   * 22,016 (`21.5kb`).
   * why: the router's input fixes (22.8.1) — a click the view transition aimed at `<html>` is given
   * to the element under the pointer, a press skips the running transition, and a press or click
   * cancels the pending prefetch, so a fast click sends one request, not two (+795 B).
   *
   * measured: 22,508 B (2026-10-02; `x build --target static`'s `budgets` step), against 22,528
   * (`22kb`).
   * why: the router's plan-101 slice 09 fixes (+774 B, router 19,269 → 20,043 B) — a reload or a
   * Back after a full load lands where the visitor left, the channel closes on `pagehide` so the
   * page can enter the back/forward cache, a form's line breaks go as CRLF, an aborted navigation's
   * sheets are retired, a finished older view transition no longer forgets the running one, and
   * `<a href="#">` and an unparsable href stay the browser's. The other +198 B is the router's
   * growth on main between 22.8.1's statement and this slice (19,071 → 19,269 B), unstated until now.
   * raised 22kb → 26kb (26.1.0, route-presented modals). measured: 26,580 B (2026-10-08;
   * `x build --target static`), against 26,624. why: the client router grew 19,966 → 24,058 B
   * (+4,092): `navigation: 'modal'` — a hash-addressed `<dialog>` over the page, reopened by a
   * reload, Back/Forward or a pasted URL, its forms posted through the router, and the router's
   * `refresh`/`openModal`/`closeModal` for navigating from code; charged to every
   * `app/` document, as the router is. Of the +4,072 B over 22,508, the router is
   * +4,092; −20 B is main's own drift between that measurement and 26.0.0.
   */
  budget: { js: '26kb' },
  meta: ({ t }) => ({ title: t('posts.create'), robots: { index: false } }),
});

export function Page(): JSX.Element {
  const t = useT();

  return (
    <Layout banner={Banner}>
      <form class={styles.form} method="post" action={CREATE_ENDPOINT}>
        <Stack gap={4}>
          <h1>{t('posts.create')}</h1>
          <Text tone="muted">{t('app.post.draftNotice')}</Text>

          <label class={styles.label} for="post-title">
            {t('posts.titleLabel')}
          </label>
          <input id="post-title" name="title" maxlength={TITLE_MAX} required type="text" />

          <label class={styles.label} for="post-body">
            {t('posts.bodyLabel')}
          </label>
          <textarea id="post-body" name="body" required />

          <div class={styles.actions}>
            <Button type="submit">{t('posts.create')}</Button>
            <a href="/feed">{t('common.cancel')}</a>
          </div>
        </Stack>
      </form>
    </Layout>
  );
}
