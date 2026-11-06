/**
 * The home page's social card: an ordinary static `site/` page laid out at exactly 1200 x 630,
 * which `x build --target static` photographs into `/_og/og/home.png` and stamps as the home page's
 * `og:image` (`og: { capture: '/og/home' }` in `../../page.tsx`). `noindex`: it is a picture's
 * source, never a search result. Brand changes reach every card with no image editor in the loop.
 */

import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import type { JSX } from 'solid-js';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'network-only',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: ({ t }) => ({
    title: t('site.hero.metaTitle'),
    description: t('site.hero.metaDescription'),
    robots: { index: false, follow: false },
  }),
});

export function Page(): JSX.Element {
  const t = useT();
  return (
    <main class={styles.card}>
      <p class={styles.brand}>{t('common.appName')}</p>
      <h1 class={styles.title}>{t('site.hero.title')}</h1>
      <p class={styles.subtitle}>{t('site.hero.subtitle')}</p>
    </main>
  );
}
