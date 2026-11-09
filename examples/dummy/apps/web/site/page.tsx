/**
 * The landing page. It lives in `site/` on purpose: the framework's own starter page is a real
 * static page with real metadata and a real 0kb budget, so a regression on the static path breaks
 * here first, visibly, instead of rotting quietly while attention goes to the app.
 */

import { priceDecimalOf } from '@postly/domain';
import { useT } from '@postly/i18n';
import { asset, defineRoute } from '@ultimat3/render';
import { ld, responsiveImage } from '@ultimat3/seo';
import { Stack } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { currencyFromUrl } from '../shared/currency';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  /** Nothing here needs JavaScript: the nav toggle is CSS, the form posts natively. */
  hydrate: 'never',
  budget: { js: '0kb' },
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
      // A page of this site, photographed at 1200 x 630 by `x build --target static` and stamped
      // as og:image (`og/home/page.tsx`): the card is the brand's own markup, never a stock PNG.
      og: { capture: '/og/home' },
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

/** The hero's intrinsic size: `assets/hero.png` is 960 x 540. */
const HERO_SIZE = { width: 960, height: 540 } as const;

export function Page(): JSX.Element {
  const t = useT();
  const hero = responsiveImage({
    src: asset('assets/hero.png'),
    ...HERO_SIZE,
    alt: t('site.hero.imageAlt'),
    sizes: '(min-width: 68rem) 960px, 100vw',
    priority: true,
  });

  return (
    <main class={styles.page}>
      <section class={styles.hero}>
        <Stack gap={4}>
          <h1>{t('site.hero.title')}</h1>
          <p class={styles.subtitle}>{t('site.hero.subtitle')}</p>
          <div class={styles.ctas}>
            {/*
              `/pricing`, not `/signup`: there is no signup route in this app and no route table
              entry for one — the sign-in surface is `app/auth/login.ts`'s two descriptors, which
              are declared, tested and NOT served (see the app's CLAUDE.md). A CTA on the one page
              a crawler indexes must land somewhere that exists, and `/pricing` is where the free
              plan and the one conversion this app can actually complete both live.
            */}
            <a class={styles.primary} href="/pricing">
              {t('site.hero.ctaPrimary')}
            </a>
            <a class={styles.secondary} href="/blog">
              {t('site.hero.ctaSecondary')}
            </a>
          </div>
        </Stack>
        {/*
          A committed asset under `site/assets/`, as a `<picture>`: the static build writes every
          width in every offered format beside the page (`/_img/…`), so a CDN serving the export
          answers `image/webp` for the webp candidate. Intrinsic size inlined, so CLS stays 0.
        */}
        <picture class={styles.heroImage}>
          <For each={hero.sources}>
            {(source) => <source type={source.type} srcset={source.srcset} sizes={source.sizes} />}
          </For>
          <img
            src={hero.img.src}
            srcset={hero.img.srcset}
            sizes={hero.img.sizes}
            alt={hero.img.alt}
            width={hero.img.width}
            height={hero.img.height}
            loading={hero.img.loading}
            decoding={hero.img.decoding}
            fetchpriority={hero.img.fetchpriority}
            style={hero.img.style}
          />
        </picture>
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
