/**
 * The landing page. It lives in `site/` on purpose: the framework's own starter page is a real
 * static page with real metadata and a real 0kb budget, so a regression on the static path breaks
 * here first, visibly, instead of rotting quietly while attention goes to the app.
 */

import { priceDecimalOf } from '@postly/domain';
import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import { Image, Stack } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { currencyFromUrl } from '../shared/currency';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  /** Nothing here needs JavaScript: the nav toggle is CSS, the form posts natively. */
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1200 },
  /**
   * The offer is the free plan read out of the catalog, in the currency the URL names — the same
   * rule `/pricing` renders from, through the same helper. A price written into this file would
   * be a second price list, and a currency written into it would contradict `?currency=` the
   * moment someone followed a link that carried one.
   */
  meta: ({ t, url }) => {
    const currency = currencyFromUrl(url);
    return {
      title: t('site.hero.metaTitle'),
      description: t('site.hero.metaDescription'),
      og: { image: '/og/home.png' },
      ld: [
        ld.SoftwareApplication({
          name: t('common.appName'),
          applicationCategory: 'BusinessApplication',
          // schema.org's vocabulary, not a user-facing string: a web app runs anywhere.
          operatingSystem: 'Any',
          url,
          offers: { price: priceDecimalOf('free', currency), priceCurrency: currency },
        }),
      ],
    };
  },
});

export function Page(): JSX.Element {
  const t = useT();

  return (
    <main class={styles.page}>
      <section class={styles.hero}>
        <Stack gap="4">
          <h1>{t('site.hero.title')}</h1>
          <p class={styles.subtitle}>{t('site.hero.subtitle')}</p>
          <div class={styles.ctas}>
            <a class={styles.primary} href="/signup">
              {t('site.hero.ctaPrimary')}
            </a>
            <a class={styles.secondary} href="/blog">
              {t('site.hero.ctaSecondary')}
            </a>
          </div>
        </Stack>

        {/* Dimensions are read at build time and inlined, so this hero costs 0 CLS. */}
        <Image
          src="/media/feed-screenshot.png"
          alt={t('site.hero.title')}
          sizes="(max-width: 700px) 100vw, 620px"
          priority
        />
      </section>

      <section class={styles.features}>
        <h2>{t('site.features.heading')}</h2>
        <ul class={styles.grid}>
          <li>
            <h3>{t('site.features.realtimeTitle')}</h3>
            <p>{t('site.features.realtimeBody')}</p>
          </li>
          <li>
            <h3>{t('site.features.offlineTitle')}</h3>
            <p>{t('site.features.offlineBody')}</p>
          </li>
          <li>
            <h3>{t('site.features.localeTitle')}</h3>
            <p>{t('site.features.localeBody')}</p>
          </li>
          <li>
            <h3>{t('site.features.moneyTitle')}</h3>
            <p>{t('site.features.moneyBody')}</p>
          </li>
        </ul>
      </section>
    </main>
  );
}
