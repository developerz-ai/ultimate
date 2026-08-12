// The landing page. site/ is 0kb JS: static render, hydrate never, no framework script tag.
// It says what this deployment IS — a framework stress test with seeded data — because an
// unlabelled demo reads as a real network, and the first thing anyone does is try to sign up.

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

/** Each row is one framework claim this deployment is the evidence for. */
const PROOFS = ['policy', 'realtime', 'offline', 'admin'] as const;

export function HomePage() {
  return (
    <main class={styles.page}>
      <section class={styles.hero}>
        <h1>{t('site.home.title')}</h1>
        <p class={styles.lede}>{t('site.home.description')}</p>
        <nav class={styles.actions}>
          <a class={styles.cta} href="/feed">
            {t('site.home.cta')}
          </a>
          <a class={styles.secondary} href="/signin">
            {t('site.home.signin')}
          </a>
        </nav>
        <p class={styles.note}>{t('site.home.seeded')}</p>
      </section>

      <section class={styles.proofs}>
        <h2>{t('site.home.proofs.title')}</h2>
        <ul class={styles.list}>
          {PROOFS.map((proof) => (
            <li class={styles.proof}>
              <h3>{t(`site.home.proofs.${proof}.title`)}</h3>
              <p>{t(`site.home.proofs.${proof}.body`)}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export const appName = 'social-media-clone';
