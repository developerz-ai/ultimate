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
 * The fragment every plan card links to. Named once because it is two things at a distance — the
 * `id` on the form and the `href` on each card — and a fragment that names nothing is a link that
 * silently does nothing. It targets the form INSIDE the `<details>`, not the `<details>` itself:
 * a browser expands a closed disclosure to reveal a fragment target within it.
 */
const CONTACT_FORM_ID = 'contact';

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
   * No `hydrate` here on purpose: the island below is the declaration, and a route carrying one
   * hydrates on `interaction`.
   *
   * measured: 21,487 B (2026-09-22; `x build`'s `buildIslands`, `hydrateRuntimeBytes`) — the
   * island chunk 19,858 + the `interaction` runtime 1,629, against 21,504. `site/`'s derived
   * ceiling is 20kb, so this route declares its own.
   * why: the island posts through the typed action client (`shared/browser-client.ts`,
   * `@ultimat3/action`'s `rpc` over `@ultimat3/core`'s one browser transport) instead of a
   * hand-rolled `fetch` — plan 101, slice 16: one naming rule, the build id every write carries
   * (so a page open across a deploy answers `X_CONTRACT_DRIFT` instead of posting a stale shape),
   * and one error decode. It was 1,894 B as an 875-byte raw-`fetch` chunk; trimming back means a
   * second transport, which is the thing slice 16 removed. It still imports no `solid-js`.
   *
   * measured: 21,617 B (2026-09-23; `x build --target static`'s `.x/build-stats.json`) — the
   * island chunk 19,988 + the `interaction` runtime 1,629, against 21,708 (`21.2kb`).
   * why: the chunk is 130 B heavier than on 2026-09-22 from `@ultimat3/core`'s browser transport,
   * which it imports whole; the in-process dispatch `x build` measures `app/` routes with costs 0 B
   * here (it wraps `fetch` server-side only), so this raise is that 130 B and nothing else.
   *
   * measured: 22,098 B (2026-09-27; `x build --target static`'s `.x/build-stats.json`) — the
   * island chunk 20,500 + the runtimes, against 22,118 (`21.6kb`).
   * why: +481 B, all function the typed client now carries: core's `actionRoute` learned the
   * `'readable'` path style (`rpc({ pathStyle })`, ~200 B), and `@ultimat3/action`'s error
   * registry — which the client imports for its decode — gained the titles of three new codes
   * (`X_ACTION_HTTP_PATH_INVALID`, `X_ACTION_PATH_STYLE_INVALID`, `X_OPENAPI_CONFIG_INVALID`).
   *
   * measured: 22,172 B (2026-09-27; `x build --target static`'s `.x/build-stats.json`), against
   * 22,221 (`21.7kb`).
   * why: +74 B, the one title the same error registry gained — `X_ACTION_PATH_DERIVED_EARLY`, the
   * refusal of a path captured before the app's `pathStyle` was declared — shortened to fit.
   *
   * measured: 22,419 B (2026-09-28; `x build --target static`'s `.x/build-stats.json`), against
   * 22,528 (`22kb`).
   * why: +207 B in the contact island, the 40 B the hydration runtime now spends visiting each
   * island root once (so the client router can re-run it over a swapped body) and core's transport
   * announcing every write (`onClientWrite`), which is what empties a router's prefetch cache. This
   * page ships no router: `site/` did not opt into client navigation.
   * raised 22kb → 23kb, measured 23,329 B (2026-10-05, plan 101 sweep 3; Bun 1.4.2,
   * `x build --target static`): +1,076 B over 22,253 for core's remote-refusal decoding, so the
   * contact form's `rpc` titles any refusal from the problem body and waits the server's stated
   * `Retry-After` on a 429/503, without shipping `@ultimat3/http` (whose undeclared `sideEffects`
   * had carried 11.5 kB of server code into this island until this sweep declared them).
   * raised 23kb → 24kb (plan 101 sweep 9). measured: 23,611 B (2026-10-05;
   * `x build --target static`), against 24,576. why: +59 B in the inline runtime — `catchUp` lets
   * go of a press after a mount it did not flush (a held island's first click ran twice, #506); the
   * other +223 B is the contact island's growth from the rest of sweep 9, measured here.
   */
  budget: { js: '24kb' },
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
              {/*
                The enquiry below, not `/signup?plan=…`: nothing serves a signup route, so the
                query string carried a plan to a 404. The form is on this page and names the same
                plan list, so the fragment is a target that exists with scripting off.
              */}
              <a class={styles.cta} href={`#${CONTACT_FORM_ID}`}>
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
          <form
            class={styles.contactForm}
            id={CONTACT_FORM_ID}
            method="post"
            action={CONTACT_ENDPOINT}
          >
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
