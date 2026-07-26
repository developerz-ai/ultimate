/**
 * Pricing. ISR because the plan catalog changes rarely and always through a write we can tag.
 * Every price on this page is an integer in minor units until `<PlanBadge>` renders it — the page
 * itself never does arithmetic and never sees a formatted string.
 */

import { tag } from '@postly/db';
import { PLAN_CATALOG, PLAN_CODES, priceOf } from '@postly/domain';
import { useT } from '@postly/i18n';
import { PlanBadge } from '@postly/ui';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import styles from './pricing.module.scss';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.plan] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1500 },
  meta: ({ t }) => ({
    title: t('site.pricing.metaTitle'),
    description: t('site.pricing.metaDescription'),
    og: { image: '/og/pricing.png' },
    ld: ld.Product({
      name: 'Postly',
      description: t('site.pricing.metaDescription'),
      offers: PLAN_CODES.map((code) => ({
        price: priceOf(code, 'USD'),
        priceCurrency: 'USD',
        name: code,
      })),
    }),
  }),
});

/**
 * The currency is a URL parameter, not a client-side toggle: each currency is its own
 * prerendered, indexable page, and no JavaScript decides what a visitor pays.
 */
export function Page(props: { readonly query: { currency?: string } }): JSX.Element {
  const t = useT();
  const currency = () => (props.query.currency === 'EUR' ? 'EUR' : 'USD');

  return (
    <main class={styles.page}>
      <h1>{t('site.pricing.heading')}</h1>
      <p class={styles.subheading}>{t('site.pricing.subheading')}</p>

      <nav class={styles.currency} aria-label={t('site.pricing.currencyLabel')}>
        <a href="/pricing?currency=USD" aria-current={currency() === 'USD'}>
          USD
        </a>
        <a href="/pricing?currency=EUR" aria-current={currency() === 'EUR'}>
          EUR
        </a>
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
