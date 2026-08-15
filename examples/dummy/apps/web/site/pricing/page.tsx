/**
 * Pricing. ISR because the plan catalog changes rarely and always through a write we can tag.
 * Every price on this page is an integer in minor units until `<PlanBadge>` renders it — the page
 * itself never does arithmetic and never sees a formatted string.
 *
 * It is also the one page on `site/` that ships JavaScript, and exactly one module of it: the
 * contact form below is an `island`, so `hydrate` is no longer `never` and `budget.js` is no
 * longer `0kb`. Every other `site/` route is untouched by that — an island is its own bundle
 * entry point, reached by specifier, so nothing here can leak into `/` or `/blog`.
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
import { derivePath } from '@ultimat3/action';
import { defineRoute, island } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import type { Api } from '../../api';
import { currencyFromUrl, currencyOf } from '../../shared/currency';
import { tag } from '../../shared/tags';
import styles from './page.module.scss';

/**
 * The action the form posts to, named once and checked by the compiler. `satisfies` is what makes
 * the string safe: a renamed action is a build error here, while `import type` keeps the value
 * edge absent — a `site/` page that imported `app/contact/actions.ts` would drag the whole feature
 * across the boundary and fail `x verify` with `X_BOUNDARY_VIOLATION`.
 */
const CONTACT_ACTION = 'contactSales' satisfies keyof Api['actions'];

/** `contactSales` → `POST /api/sales/contact`. Derived, never spelled out — one naming rule. */
const CONTACT_ENDPOINT = derivePath(CONTACT_ACTION).path;

/**
 * The page's one island. `props` are the exact keys the browser gets: JSON, already translated,
 * and nothing else — a callback cannot cross this seam, which is why the island calls the action
 * itself rather than being handed an `onSubmit`. Timing is the route's `hydrate`, never declared
 * here; `interaction` means the chunk is fetched on the first click and that click is replayed.
 */
const ContactSales = island({
  src: './contact-sales.island.tsx',
  props: ['sendingLabel', 'sentLabel', 'failedLabel'],
  events: ['click'],
});

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.plan] },
  offline: 'runtime',
  /**
   * No `hydrate` and no `budget.js` here on purpose: the island below is the whole declaration.
   * A route carrying one hydrates on `interaction` and gets `site/`'s 4kb ceiling derived for it,
   * so the two facts the framework can work out are not two more lines to forget. The measured
   * cost is 1894 bytes — an 875-byte chunk plus the interaction runtime. `lcp` stays because
   * nothing derives it.
   */
  budget: { lcp: 1500 },
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

      {/* The island. Everything inside it is server-rendered — the disclosure, the form, every
          label and the plan list — so the enquiry sends with scripting off, straight to the same
          action. What the client module adds is the answer in place, which a full page load
          cannot give. */}
      <ContactSales
        sendingLabel={t('site.pricing.contact.sending')}
        sentLabel={t('site.pricing.contact.sent')}
        failedLabel={t('site.pricing.contact.failed')}
      >
        <details class={styles.contact}>
          <summary class={styles.contactTrigger}>{t('site.pricing.contact.open')}</summary>
          <form class={styles.contactForm} method="post" action={CONTACT_ENDPOINT}>
            <p class={styles.contactIntro}>{t('site.pricing.contact.intro')}</p>

            <label class={styles.contactField}>
              {t('site.pricing.contact.email')}
              <input type="email" name="email" autocomplete="email" required />
            </label>

            <label class={styles.contactField}>
              {t('site.pricing.contact.plan')}
              {/* Off the catalog, like the cards above: an enquiry cannot name a plan Postly
                  does not sell, and the action's own input is the same enumeration. */}
              <select name="plan">
                <For each={PLAN_CODES}>
                  {(code) => <option value={code}>{t(`plans.${code}.name`)}</option>}
                </For>
              </select>
            </label>

            <label class={styles.contactField}>
              {t('site.pricing.contact.message')}
              {/* No `maxlength` here on purpose: `contactSales` owns the length rule, and a
                  second copy in this file is the one that goes stale. */}
              <textarea name="message" rows="4" required />
            </label>

            {/* The currency the URL named, and the locale this render used — both facts the
                server already decided, travelling as fields rather than as guesses made in the
                browser. */}
            <input type="hidden" name="currency" value={currency()} />
            <input type="hidden" name="locale" value={t.locale} />

            <p class={styles.contactStatus} data-role="status" role="status" aria-live="polite" />

            <button class={styles.contactSubmit} type="submit">
              {t('site.pricing.contact.send')}
            </button>
          </form>
        </details>
      </ContactSales>
    </main>
  );
}
