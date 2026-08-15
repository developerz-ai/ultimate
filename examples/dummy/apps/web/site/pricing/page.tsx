/**
 * Pricing. ISR because the plan catalog changes rarely and always through a write we can tag.
 * Every price on this page is an integer in minor units until `<PlanBadge>` renders it — the page
 * itself never does arithmetic and never sees a formatted string.
 */

import {
  BILLING_CURRENCIES,
  PLAN_CATALOG,
  PLAN_CODES,
  priceDecimalOf,
  priceOf,
} from '@postly/domain';
import { useT } from '@postly/i18n';
import { PlanBadge } from '@postly/ui';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { currencyFromUrl, currencyOf } from '../../shared/currency';
import { tag } from '../../shared/tags';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.plan] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1500 },
  /**
   * One `Product` per plan, not one product carrying three offers: `ld.Product` takes a single
   * offer, and three plans genuinely are three things a visitor can buy. Every price and every
   * currency comes out of the catalog in the currency `url` names — the same rule the body below
   * renders from, so the structured data can never quote a currency the page does not show.
   */
  meta: ({ t, url }) => {
    const currency = currencyFromUrl(url);
    return {
      title: t('site.pricing.metaTitle'),
      description: t('site.pricing.metaDescription'),
      og: { image: '/og/pricing.png' },
      ld: PLAN_CODES.map((code) =>
        ld.Product({
          name: t(`plans.${code}.name`),
          description: t(`plans.${code}.description`),
          offers: { price: priceDecimalOf(code, currency), priceCurrency: currency },
        }),
      ),
    };
  },
});

/**
 * The currency is a URL parameter, not a client-side toggle: each currency is its own
 * prerendered, indexable page, and no JavaScript decides what a visitor pays. `currencyOf` is the
 * same rule `meta` above applies to `url`, so a page cannot show one currency and declare another.
 */
export function Page(props: { readonly query: { currency?: string } }): JSX.Element {
  const t = useT();
  const currency = () => currencyOf(props.query.currency);

  return (
    <main class={styles.page}>
      <h1>{t('site.pricing.heading')}</h1>
      <p class={styles.subheading}>{t('site.pricing.subheading')}</p>

      {/* Off the catalog, never a hand-written pair: a currency Postly prices in is one the
          switcher offers, and adding a fourth market is a row in the catalog, not markup here. */}
      <nav class={styles.currency} aria-label={t('site.pricing.currencyLabel')}>
        <For each={BILLING_CURRENCIES}>
          {(code) => (
            <a href={`/pricing?currency=${code}`} aria-current={currency() === code}>
              {code}
            </a>
          )}
        </For>
      </nav>

      <ul class={styles.plans}>
        <For each={PLAN_CODES}>
          {(code) => (
            <li class={styles.plan}>
              <PlanBadge
                plan={code}
                price={priceOf(code, currency())}
                seats={PLAN_CATALOG[code].seats}
                withDescription
              />
              <a class={styles.cta} href={`/signup?plan=${code}&currency=${currency()}`}>
                {t('site.pricing.cta', { plan: t(`plans.${code}.name`) })}
              </a>
            </li>
          )}
        </For>
      </ul>

      <section class={styles.included}>
        <h2>{t('site.pricing.included')}</h2>
        <p>{t('site.pricing.includedList')}</p>
      </section>
    </main>
  );
}
