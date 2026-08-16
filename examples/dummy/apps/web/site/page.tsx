/**
 * The landing page. It lives in `site/` on purpose: the framework's own starter page is a real
 * static page with real metadata and a real 0kb budget, so a regression on the static path breaks
 * here first, visibly, instead of rotting quietly while attention goes to the app.
 */

import { priceDecimalOf } from '@postly/domain';
import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import { Stack } from '@ultimat3/ui';
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
        {/*
          No hero image. `/media/*key` is the STORAGE route — one disk holding every tenant's
          uploads — so it is `auth: 'required'`, and an anonymous marketing page asking it for
          `feed-screenshot.png` is a 401 (it was a 404 before, because nothing ever wrote that
          object). A genuinely public image belongs under `apps/web/site/` as a committed asset, and
          this app has no static-asset route to serve one from yet, so the honest answer is no image
          rather than a broken one. See `packages/cli/src/dev-assets.ts`.
        */}
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
