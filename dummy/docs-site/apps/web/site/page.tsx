// The front door: what Ultimate is, how to run it, the live demo, why, and when not to use it.
// Authored, not `wiki/Home.md` verbatim — the manual's own front page is `/docs`. Static, 0 KB.
//
// Strings come from `useT()` — this app's own catalog module — and never from `t` in
// @ultimat3/i18n: that import is what registers the catalogs (issue #249). The commands are code,
// not prose: the same in every locale, so they are constants and never catalog strings.
import { useT } from '@docs-site/i18n';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import { Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { DocsShell } from '../shared/docs-shell';
import styles from './page.module.scss';

/** The commands a stranger types first, in order. */
export const FIRST_COMMANDS = [
  'bunx create-ultimate myapp',
  'cd myapp && bun run setup',
  'bun run dev',
];

export const VERIFY_COMMAND = 'bun run verify';

/** The deployed demo (`.github/workflows/deploy-social-demo.yml` publishes its image). */
export const DEMO_URL = 'https://social-media.ultimate.demo.developerz.ai';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb' },
  meta: ({ t, url }) => ({
    title: t('site.home.title'),
    description: t('site.home.description'),
    canonical: url,
    ld: [ld.WebSite({ name: t('shell.brand'), url })],
  }),
});

export function Page(): JSX.Element {
  const t = useT();
  return (
    <DocsShell>
      <header class={styles.hero}>
        <p class={styles.eyebrow}>{t('site.home.eyebrow')}</p>
        <h1 class={styles.title}>{t('site.home.headline')}</h1>
        <p class={styles.lede}>{t('site.home.lede')}</p>
        <p class={styles.actions}>
          <Link href="/getting-started">{t('site.home.startLink')}</Link>
          <Link href="/docs">{t('site.home.manualLink')}</Link>
        </p>
      </header>
      <section class={styles.section}>
        <h2>{t('site.home.runTitle')}</h2>
        <p>{t('site.home.runBody')}</p>
        <pre class={styles.commands}>
          <code>{[...FIRST_COMMANDS, VERIFY_COMMAND].join('\n')}</code>
        </pre>
        <p>{t('site.home.runVerify')}</p>
      </section>
      <section class={styles.section}>
        <h2>{t('site.home.demoTitle')}</h2>
        <p>{t('site.home.demoBody')}</p>
        <p>
          <Link href={DEMO_URL} external>
            {t('site.home.demoLink')}
          </Link>
        </p>
      </section>
      <section class={styles.section}>
        <h2>{t('site.home.whyTitle')}</h2>
        <ul>
          <For each={[t('site.home.whyEight'), t('site.home.whyErrors'), t('site.home.whyBudget')]}>
            {(line) => <li>{line}</li>}
          </For>
        </ul>
      </section>
      <section class={styles.section}>
        <h2>{t('site.home.whenNotTitle')}</h2>
        <p>{t('site.home.whenNotBody')}</p>
      </section>
    </DocsShell>
  );
}
