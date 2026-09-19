// The generated landing page — `apps/web/site/page.tsx` and its stylesheet and test. Split out of
// `scaffold-app.ts` when it grew from an `<h1>` and a link into a hero: a dot-grid ground, an
// eyebrow, a balanced headline, a lede, two calls to action and three feature cards, every string
// a catalog key and every colour a token. Still 0kb: `render: 'static'`, `hydrate: 'never'`, no
// island, and it does not wear the app shell — see the page's own header comment.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';

// Plain strings for the framework lines, never template literals: the workspace-dependency scanner
// blanks a string's contents but not a nested template's, so a template here would bill the CLI
// for the imports of the app it writes.
const sitePage = (
  app: NameSet,
): string => `// The landing page. site/ is 0kb JS: static render, hydrate never, no framework script tag.
//
// Strings come from \`useT()\` — this app's own catalog module — and never from
// \`t\` in @ultimat3/i18n. That import is what puts the module holding \`defineCatalogs()\` in
// this page's graph, so rendering a string is what registers the catalogs. A page that reached
// past it shipped every string as \`\u27e6key\u27e7\` with \`x verify\` green (issue #249).
//
// Not inside \`shared/shell.tsx\`: the shell is the signed-in product's chrome, and a landing page
// that wore it would ship a sidebar to visitors who cannot open anything in it.
${sortedImports([
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { defineRoute } from '@ultimat3/render';",
  "import { Icon } from '@ultimat3/ui';",
  "import { iconArrowRight } from '@ultimat3/ui/icons/arrow-right';",
  "import { iconGauge } from '@ultimat3/ui/icons/gauge';",
  "import { iconShieldCheck } from '@ultimat3/ui/icons/shield-check';",
  "import { iconZap } from '@ultimat3/ui/icons/zap';",
])}
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  budget: { js: '0kb' },
  // \`t\` is handed to \`meta\` by the router — one translator per render, resolved against the
  // request's locale before the head is built.
  meta: ({ t }) => ({
    title: t('site.home.title'),
    description: t('site.home.description'),
  }),
});

export function HomePage() {
  const t = useT();

  return (
    <main class={styles.page}>
      <header class={styles.hero}>
        <p class={styles.eyebrow}>{t('site.home.eyebrow')}</p>
        <h1 class={styles.title}>{t('site.home.headline')}</h1>
        <p class={styles.lede}>{t('site.home.lede')}</p>
        <div class={styles.actions}>
          <a class={styles.cta} href="/dashboard">
            {t('site.home.cta')}
            <Icon glyph={iconArrowRight} size="sm" />
          </a>
          <a class={styles.ghost} href="/admin">
            {t('site.home.secondary')}
          </a>
        </div>
      </header>
      {/* What this app already IS, in three facts — not three adjectives. Static markup: this
          route ships no island and its JS budget is zero. */}
      <ul class={styles.features}>
        <li class={styles.feature}>
          <span class={styles.featureIcon} aria-hidden="true">
            <Icon glyph={iconZap} size="sm" />
          </span>
          <h2>{t('site.home.f1Title')}</h2>
          <p>{t('site.home.f1Body')}</p>
        </li>
        <li class={styles.feature}>
          <span class={styles.featureIcon} aria-hidden="true">
            <Icon glyph={iconShieldCheck} size="sm" />
          </span>
          <h2>{t('site.home.f2Title')}</h2>
          <p>{t('site.home.f2Body')}</p>
        </li>
        <li class={styles.feature}>
          <span class={styles.featureIcon} aria-hidden="true">
            <Icon glyph={iconGauge} size="sm" />
          </span>
          <h2>{t('site.home.f3Title')}</h2>
          <p>{t('site.home.f3Body')}</p>
        </li>
      </ul>
    </main>
  );
}

export const appName = '${app.kebab}';
`;

const siteStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: flex;
  flex-direction: column;
  gap: tokens.space(12);
  max-inline-size: 72rem;
  min-block-size: 100dvh;
  margin-inline: auto;
  padding: tokens.space(8) tokens.space(4) tokens.space(16);
  background: tokens.role('bg');
  color: tokens.role('fg');

  @include tokens.respond-to(md) {
    padding: tokens.space(16) tokens.space(8);
  }
}

.hero {
  @include tokens.dot-grid;

  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: tokens.space(5);
  padding: tokens.space(8) tokens.space(6);
  overflow: hidden;
  border: 1px solid tokens.role('line', 0.6);
  border-radius: tokens.radius('xl');

  @include tokens.respond-to(md) {
    padding: tokens.space(16) tokens.space(12);
  }
}

.eyebrow {
  @include tokens.label-caps;

  margin: 0;
  padding: tokens.space(1) tokens.space(3);
  border: 1px solid tokens.role('accent', 0.35);
  border-radius: tokens.radius('pill');
  background: tokens.role('accent', 0.1);
  color: tokens.role('accent');
}

.title {
  max-inline-size: 18ch;
  margin: 0;
  color: tokens.role('fg-strong');
  font-size: tokens.text('3xl');
  font-weight: tokens.weight('semibold');
  letter-spacing: tokens.tracking('tight');
  line-height: 1.05;
  text-wrap: balance;
}

.lede {
  max-inline-size: 36rem;
  margin: 0;
  color: tokens.role('fg-muted');
  font-size: tokens.text('lg');
  line-height: tokens.leading('normal');
  text-wrap: pretty;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: tokens.space(3);
  margin-block-start: tokens.space(2);
}

// Both calls to action share one shape; only the paint differs.
@mixin action {
  @include tokens.focus-ring;

  display: inline-flex;
  align-items: center;
  gap: tokens.space(2);
  block-size: 2.75rem;
  padding-inline: tokens.space(5);
  border-radius: tokens.radius('md');
  font-weight: tokens.weight('medium');
  text-decoration: none;
  transition:
    background-color tokens.duration('fast') tokens.easing('out'),
    border-color tokens.duration('fast') tokens.easing('out'),
    color tokens.duration('fast') tokens.easing('out');
}

.cta {
  @include action;

  background: tokens.role('accent');
  color: tokens.role('accent-fg');

  &:hover {
    background: tokens.role('accent-strong');
  }
}

.ghost {
  @include action;

  border: 1px solid tokens.role('line');
  color: tokens.role('fg');

  &:hover {
    border-color: tokens.role('fg-muted');
    color: tokens.role('fg-strong');
  }
}

.features {
  display: grid;
  gap: tokens.space(4);
  margin: 0;
  padding: 0;
  list-style: none;

  @include tokens.respond-to(md) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.feature {
  display: flex;
  flex-direction: column;
  gap: tokens.space(3);
  padding: tokens.space(6);
  border: 1px solid tokens.role('line', 0.6);
  border-radius: tokens.radius('lg');
  background: tokens.role('surface');

  h2 {
    margin: 0;
    color: tokens.role('fg-strong');
    font-size: tokens.text('md');
    font-weight: tokens.weight('medium');
  }

  p {
    margin: 0;
    color: tokens.role('fg-muted');
    font-size: tokens.text('sm');
    line-height: tokens.leading('normal');
  }
}

.featureIcon {
  display: inline-grid;
  place-items: center;
  inline-size: tokens.space(8);
  block-size: tokens.space(8);
  border: 1px solid tokens.role('line');
  border-radius: tokens.radius('md');
  background: tokens.role('surface-raised');
  color: tokens.role('accent');
}
`;

const sitePageTest =
  (): string => `// The landing page ships zero JS and declares its metadata. Both are promises the file makes in
// its config, and both are the kind that rot silently when someone adds one import.
import { metaContextFor, routeDataFor } from '@ultimat3/render';
import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

// The same two objects a render builds: \`routeDataFor\` resolves the route's data once, and
// \`metaContextFor\` wraps it the way every render mode wraps it before calling \`meta\`.
const ctx = { params: {}, url: 'https://example.test/' };

unitTest('the landing page ships zero JS and declares metadata', async () => {
  expect(config.render).toBe('static');
  expect(config.hydrate).toBe('never');
  expect(config.budget.js).toBe('0kb');
  const meta = await config.meta(metaContextFor(ctx, await routeDataFor(config, ctx)));
  expect(meta.title ?? '').not.toBe('');
});
`;

/** The landing page, its stylesheet and its test. */
export const siteFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: 'apps/web/site/page.tsx', contents: sitePage(app) },
  { path: 'apps/web/site/page.module.scss', contents: siteStyle() },
  { path: 'apps/web/site/page.test.ts', contents: sitePageTest() },
];
