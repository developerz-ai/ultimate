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
   * `auth: 'public'` (`packages/cli/src/dev-render.ts`'s `metaOf`), which also drops `vary: cookie`
   * off the response. The row-level half stays with `createPost`'s own `postCreate`.
   */
  policy: { permission: 'post:create' satisfies KnownPermission },
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
   */
  budget: { js: '3kb', lcp: 1200 },
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
