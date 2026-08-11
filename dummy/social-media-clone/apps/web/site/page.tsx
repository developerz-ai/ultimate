// The landing page. site/ is 0kb JS: static render, hydrate never, no framework script tag.
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({
    title: t('site.home.title'),
    description: t('site.home.description'),
  }),
});

export function HomePage() {
  return (
    <main class={styles.hero}>
      <h1>{t('site.home.title')}</h1>
      <p>{t('site.home.description')}</p>
      <a class={styles.cta} href="/dashboard">
        {t('site.home.cta')}
      </a>
    </main>
  );
}

export const appName = 'social-media-clone';
