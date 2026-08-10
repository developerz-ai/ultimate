/**
 * The editor. A native `<form>` posting to the action's generated route, so it works before
 * hydration, with JavaScript disabled, and from the offline fallback's queue. There is no
 * client-side form library, because there is nothing here a browser does not already do.
 */

import { TITLE_MAX } from '@postly/domain';
import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import { Button, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Layout } from '../../layout';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  offline: 'runtime',
  /** The only interactive part is the submit button, which the browser owns. */
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1200 },
  meta: ({ t }) => ({ title: t('posts.create'), robots: 'noindex' }),
});

export function Page(): JSX.Element {
  const t = useT();

  return (
    <Layout>
      <form class={styles.form} method="post" action="/_x/action/create-post">
        <Stack gap="4">
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
