// The landing page. site/ is 0kb JS: static render, hydrate never, no framework script tag.
// It says what this deployment IS — a framework stress test with seeded data — because an
// unlabelled demo reads as a real network, and the first thing anyone does is try to sign up.
//
// Everything below is server-rendered through the framework's inert JSX factory, so there is no
// client state to reach for: the hero's depth is two gradients over a masked grid, and the only
// motion in the page is a hover that a reduced-motion viewer never gets.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { Icon } from '@ultimat3/ui';
import { iconArrowRight } from '@ultimat3/ui/icons/arrow-right';
import { iconCircleCheck } from '@ultimat3/ui/icons/circle-check';
import { iconEyeOff } from '@ultimat3/ui/icons/eye-off';
import { ActionLink } from '../shared/ui/action';
import { AppShell } from '../shared/ui/app-shell';
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

/** Four numbers a reader can check against this very page. Nothing aspirational. */
const STATS = ['primitives', 'js', 'authz', 'packages'] as const;

const POINTS = ['one', 'two', 'three'] as const;

/**
 * The audience ladder as an anonymous reader meets it — the app's whole subject, in three rows.
 * The audience names are the domain's own literals (`Audience` in packages/domain), not prose: a
 * translated identifier is an identifier that no longer matches the column it names.
 */
const DECISION: readonly { readonly audience: string; readonly visible: boolean }[] = [
  { audience: 'public', visible: true },
  { audience: 'friends', visible: false },
  { audience: 'private', visible: false },
];

/** The feed route's own declaration, verbatim. A file path is an identifier, so it is not translated. */
const SAMPLE_FILE = 'apps/web/site/feed/page.tsx';

const SAMPLE: readonly { readonly text: string; readonly comment?: true }[] = [
  { text: '// the directory is the URL', comment: true },
  { text: 'export const config = defineRoute({' },
  { text: "  render: 'ssr'," },
  { text: "  hydrate: 'never'," },
  { text: "  offline: 'runtime'," },
  { text: "  budget: { js: '0kb' }," },
  { text: '});' },
];

export function HomePage(props: { readonly url?: string | undefined }) {
  return (
    <AppShell url={props.url} width="full">
      <section class={styles.hero}>
        <div class={styles.heroInner}>
          <div class={styles.heroText}>
            <p class={styles.eyebrow}>
              <span class={styles.pulse} aria-hidden="true" />
              {t('site.home.eyebrow')}
            </p>
            <h1 class={styles.title}>{t('site.home.title')}</h1>
            <p class={styles.lede}>{t('site.home.description')}</p>

            <div class={styles.ctas}>
              <ActionLink href="/feed" size="lg">
                {t('site.home.cta')}
                <Icon glyph={iconArrowRight} />
              </ActionLink>
              <ActionLink href="/signin" size="lg" variant="secondary">
                {t('site.home.signin')}
              </ActionLink>
            </div>

            <p class={styles.note}>{t('site.home.seeded')}</p>
          </div>

          <div class={styles.decision}>
            <p class={styles.decisionBar}>canSeePost(null, post)</p>
            <p class={styles.decisionCaption}>{t('site.home.decision.caption')}</p>
            <ul class={styles.decisionList}>
              {DECISION.map((row) => (
                <li class={row.visible ? styles.rowVisible : styles.rowHidden}>
                  <span class={styles.rowKey}>audience: {row.audience}</span>
                  <span class={styles.rowVerdict}>
                    <Icon glyph={row.visible ? iconCircleCheck : iconEyeOff} />
                    {/* Two literal calls, not one with a computed key: `x i18n check` can only see
                        a literal, and a key it cannot see is a key it reports as safe to delete. */}
                    {row.visible ? t('site.home.decision.visible') : t('site.home.decision.hidden')}
                  </span>
                </li>
              ))}
            </ul>
            <p class={styles.decisionNote}>{t('site.home.decision.note')}</p>
          </div>
        </div>

        <div class={styles.statsRow}>
          <dl class={styles.stats}>
            {STATS.map((stat) => (
              <div class={styles.stat}>
                <dt class={styles.statLabel}>{t(`site.home.stats.${stat}.label`)}</dt>
                <dd class={styles.statValue}>{t(`site.home.stats.${stat}.value`)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section class={styles.band}>
        <div class={styles.bandInner}>
          <h2 class={styles.bandTitle}>{t('site.home.proofs.title')}</h2>
          <ul class={styles.proofs}>
            {PROOFS.map((proof, index) => (
              <li class={styles.proof}>
                <span class={styles.proofIndex} aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3 class={styles.proofTitle}>{t(`site.home.proofs.${proof}.title`)}</h3>
                <p class={styles.proofBody}>{t(`site.home.proofs.${proof}.body`)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section class={styles.bandAlt}>
        <div class={styles.declare}>
          <div class={styles.declareText}>
            <h2 class={styles.bandTitle}>{t('site.home.declaration.title')}</h2>
            <p class={styles.bandLede}>{t('site.home.declaration.body')}</p>
            <ul class={styles.points}>
              {POINTS.map((point) => (
                <li class={styles.point}>
                  <Icon glyph={iconCircleCheck} />
                  {t(`site.home.declaration.point.${point}`)}
                </li>
              ))}
            </ul>
          </div>

          <figure class={styles.sample}>
            <figcaption class={styles.sampleBar}>{SAMPLE_FILE}</figcaption>
            <pre class={styles.pre}>
              <code>
                {SAMPLE.map((line) => (
                  <span class={line.comment === true ? styles.comment : styles.code}>
                    {`${line.text}\n`}
                  </span>
                ))}
              </code>
            </pre>
          </figure>
        </div>
      </section>

      <section class={styles.closing}>
        <div class={styles.closingInner}>
          <h2 class={styles.closingTitle}>{t('site.home.closing.title')}</h2>
          <p class={styles.closingBody}>{t('site.home.closing.body')}</p>
          <div class={styles.ctas}>
            <ActionLink href="/feed" size="lg">
              {t('site.home.closing.cta')}
              <Icon glyph={iconArrowRight} />
            </ActionLink>
            <ActionLink href="/signup" size="lg" variant="secondary">
              {t('site.home.closing.secondary')}
            </ActionLink>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

export const appName = 'social-media-clone';
