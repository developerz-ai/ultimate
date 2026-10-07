// `x g resource <name>`'s page: the plural route a slice is reached at. It READS — `load` calls the
// slice's own query as the request's actor — renders the rows through the slice's list component
// inside `AsyncRegion` (ready, empty, failed), and mounts the slice's form island. `x g route`
// writes a page with a heading and nothing to read; a resource has rows and a form, and a page
// that showed neither was a slice nobody could reach without wiring it by hand.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { titleKey } from './naming';
import { formIslandSpecifier } from './resource-form-island';
import { LINE_WIDTH } from './wrap';

/**
 * The page's JS budget — MEASURED, never a ceiling picked to pass. `x build --target static` on a
 * fresh `x new` app with `x g resource widget` under CI's `file:` links, Bun 1.4.2 (CI's pin),
 * 2026-10-05: 59,679 B — the form island 58,824 + the `visible` hydration runtime 855 (57,667 + 855
 * on 1.4.0). 64kb is 65,536: the headroom is Bun's own movement on one source between releases —
 * 1.4.0 → 1.4.2 moved this island +1,157 B, and a patch release that keeps core's declared modules
 * measured +3.0 kB on the scaffold's theme island. Two builds of one source are
 * byte-identical since 1.4.1 (issue #354), so no headroom is held for run-to-run movement. An app
 * that adds per-document scripts (`navigation: { client: [...] }` charges its router, ~18 kB, to
 * every `app/` page) is over it on its first build, and `nextSteps` sends the author there.
 */
export const RESOURCE_PAGE_BUDGET = '64kb';
export const RESOURCE_PAGE_MEASURED = '59,679 B';

/** How the page reaches a string — the same rule `route.ts` states, for the same issue (#249). */
const catalogImport = (module: string | undefined): string =>
  module === undefined
    ? "import { t } from '@ultimat3/i18n';"
    : `import { useT } from '${module}';`;

/** `currentLocale` rides on the framework import when the app has no catalog module. */
const i18nImports = (module: string | undefined): readonly string[] =>
  module === undefined
    ? ["import { currentLocale, t } from '@ultimat3/i18n';"]
    : [catalogImport(module), "import { currentLocale } from '@ultimat3/i18n';"];

/** `const load = … => rowsState(() => <read>(input()));`, as Biome prints it at any name length. */
const loadLine = (read: string): string => {
  const head = 'const load = (): Promise<PageData> =>';
  const body = `rowsState(() => ${read}(input()));`;
  return `${head} ${body}`.length <= LINE_WIDTH ? `${head} ${body}` : `${head}\n  ${body}`;
};

export interface ResourcePageOptions {
  readonly feature: NameSet;
  /** The slice: `apps/web/app/<feature>`. */
  readonly dir: string;
  /** Where the page lands: `apps/web/app/<features>`. */
  readonly pageDir: string;
  readonly catalogModule?: string;
  /** The app has `apps/web/shared/shell.tsx` — every `x new` app does — so the page sits in it. */
  readonly shell: boolean;
  readonly dbModule: string;
}

const pageSource = (options: ResourcePageOptions): string => {
  const { feature } = options;
  const path = feature.pluralKebab;
  const list = `${feature.camel}List`;
  const open = options.shell
    ? '<Shell>\n      <div class={styles.page}>'
    : '<main class={styles.page}>';
  const close = options.shell ? '      </div>\n    </Shell>' : '    </main>';
  const indent = options.shell ? '        ' : '      ';
  const inner = (lines: string): string =>
    lines
      .split('\n')
      .map((line) => (line === '' ? line : `${indent}${line}`))
      .join('\n');
  return `// /${path}: the org's ${feature.pluralKebab}, newest first, and the form that adds one. \`load\`
// reads through the slice's own query, so the policy, the tenancy and the order are the query's;
// the form is the slice's island, the one module of this page a browser downloads.

${sortedImports([
  ...i18nImports(options.catalogModule),
  "import { derivePath } from '@ultimat3/action';",
  "import type { AsyncState } from '@ultimat3/core';",
  "import type { KnownPermission } from '@ultimat3/policy';",
  "import { defineRoute, island } from '@ultimat3/render';",
  "import { AsyncRegion, EmptyState, PageHeader, Section, Skeleton } from '@ultimat3/ui';",
])}
${options.shell ? "import { Shell } from '../../shared/shell';\n" : ''}import type { ${feature.pascal} } from '../${feature.kebab}/entity';
import { ${list} } from '../${feature.kebab}/live/${feature.kebab}-list';
import { ${feature.pascal}List } from '../${feature.kebab}/ui';
import styles from './page.module.scss';

/** One page of rows: the read's own bound. Past it, page with a cursor (\`${list}.page\`). */
const PAGE_ROWS = 50;

/** The currency a price is typed in; the form sends integer minor units of it. */
const CURRENCY = 'USD';

type Row = ${feature.pascal};

/** What \`load\` answers: the read's outcome as DATA, so the page renders each of its states. */
export type PageData = AsyncState<readonly Row[]>;

/**
 * The read, as a state. A refusal or a failed read is the region's error branch — code, cause and
 * fix on screen, the form still there — never a 500 for the whole document.
 */
export async function rowsState(read: () => Promise<readonly Row[]>): Promise<PageData> {
  try {
    return { status: 'ready', data: await read() };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/** No org: the query reads the ACTOR's, so a read can only ever be for the caller's own org. */
const input = () => ({ limit: PAGE_ROWS });

${loadLine(list)}

// Declared ABOVE \`defineRoute\`: the route drains the islands declared before it. Named by
// SPECIFIER, never imported — a string has no import edge, so the page's bundle graph stays the
// page's (axiom 6). \`props\` are exactly the form's \`${feature.pascal}FormProps\` keys.
const ${feature.pascal}Form = island({
  src: '${formIslandSpecifier(feature, options.dir, options.pageDir)}',
  props: ['endpoint', 'locale', 'currency', 'labels'],
});

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'visible',
  offline: 'runtime',
  // An org's rows are not public: a route with no policy registers \`auth: 'public'\` and its
  // response carries no \`vary: cookie\`. Which ORG is the query's decision, on every read.
  policy: { permission: '${feature.kebab}:read' satisfies KnownPermission },
  // measured: ${RESOURCE_PAGE_MEASURED} (\`x build --target static\`, Bun 1.4.0) — the form island and the
  // \`visible\` runtime. why: the form is Solid, @ultimat3/ui's Form/Input/Button and the transport.
  // A raise states its own measured bytes and why here, in the same diff (\`X_BUDGET_EXCEEDED\`).
  budget: { js: '${RESOURCE_PAGE_BUDGET}' },
  load,
  meta: ({ t }) => ({
    title: t('${titleKey(path)}'),
    description: t('${titleKey(path).replace('.title', '.description')}'),
  }),
});

export interface PageProps {
  readonly data: PageData;
}

export function Page(props: PageProps) {${options.catalogModule === undefined ? '' : '\n  const t = useT();\n'}
  return (
    ${open}
${inner(`<PageHeader title={t('${titleKey(path)}')} />
<Section title={t('app.${feature.kebab}.new')}>
  <${feature.pascal}Form
    endpoint={derivePath('create${feature.pascal}').path}
    locale={currentLocale()}
    currency={CURRENCY}
    labels={{
      title: t('app.${feature.kebab}.titleLabel'),
      price: t('app.${feature.kebab}.priceLabel'),
      submit: t('app.${feature.kebab}.submit'),
      saved: t('app.${feature.kebab}.saved'),
      retry: t('app.${feature.kebab}.retry'),
    }}
  >
    <Skeleton lines={3} />
  </${feature.pascal}Form>
</Section>
<AsyncRegion
  state={props.data}
  reserve={{ lines: 3 }}
  empty={() => <EmptyState title={t('app.${feature.kebab}.empty')} />}
  ready={(rows) => <${feature.pascal}List rows={rows} />}
/>`)}
${close}
  );
}
`;
};

const ORG = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

const pageTest = (options: ResourcePageOptions): string => {
  const { feature } = options;
  const t = options.catalogModule === undefined ? '' : '\n  const t = useT();';
  return `// /${feature.pluralKebab}, rendered as a request renders it: \`load\` reads the actor's org through the
// slice's query — the in-memory driver under test — and the page shows the rows, the empty state
// or the refusal, with the form island beside them in every one.
${sortedImports([
  catalogImport(options.catalogModule),
  `import { driver } from '${options.dbModule}';`,
  "import { ctxOf, frozenClock, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { afterEach, expect, renderRoute, unitTest } from '@ultimat3/testing';",
])}
// The app's API, as boot loads it: \`defineApi\` is what names the query the page reads, and a
// query with no name is refused (X_QUERY_UNREGISTERED) before it reads a row.
import '../../api';
import * as repo from '../${feature.kebab}/repo';
import * as page from './page';

const url = 'https://example.test/${feature.pluralKebab}';
const orgId = '${ORG}';
const otherOrg = '${OTHER_ORG}';
// The read grant, named once so every line below fits the formatter's width at any feature name.
const read = '${feature.kebab}:read';
// Holds the read grant in the org: what a member of it is.
const member = testActor('member', { orgId, permissions: [read] }).actor;

// The request clock, so \`createdAt\` is an instant this file chose and "newest" is decidable.
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (title: string) => {
  const draft = { orgId, title, price: { minor: 1200, currency: 'USD' } };
  return runWithContext(ctxOf({ actor: member, clock }), () => repo.insert(draft));
};

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('the page lists the org’s rows, newest first, beside the form', async () => {
  await store('older');
  clock.advance(1000);
  await store('newer');
  const view = await renderRoute(page, { url, actor: member });
  expect(view.data.status).toBe('ready');
  expect(view.text.indexOf('newer')).toBeLessThan(view.text.indexOf('older'));
  // The form is the one island, and it wakes when it is visible.
  expect(view.islands.map((island) => island.strategy)).toEqual(['visible']);
  expect(view.islands[0]?.moduleId).toContain('${feature.kebab}-form');
});

unitTest('an org with no rows reads the empty state, not an empty list', async () => {${t}
  const view = await renderRoute(page, { url, actor: member });
  expect(view.data).toEqual({ status: 'ready', data: [] });
  expect(view.text).toContain(t('app.${feature.kebab}.empty'));
  expect(view.meta.title).toBe(t('${titleKey(feature.pluralKebab)}'));
});

unitTest('a member of another org reads none of this org’s rows', async () => {
  await store('ours');
  // The same page, the same URL: which org it reads is the actor's, never a parameter.
  const outsider = testActor('outsider', { orgId: otherOrg, permissions: [read] }).actor;
  const view = await renderRoute(page, { url, actor: outsider });
  expect(view.data).toEqual({ status: 'ready', data: [] });
});

unitTest('a caller the read refuses sees the refusal, and the page around it', async () => {
  // In the org, without the grant: the query's policy refuses before any row is read.
  const stranger = testActor('stranger', { orgId }).actor;
  const view = await renderRoute(page, { url, actor: stranger });
  expect(view.data.status).toBe('failed');
  expect(view.html).toContain('X_FORBIDDEN');
  expect(view.islands).toHaveLength(1);
});

unitTest('it is gated, rendered per request, and budgeted', () => {
  expect(page.config.render).toBe('ssr');
  expect(page.config.policy?.permission).toBe(read);
  expect(page.config.offline).toBe('runtime');
  expect(page.config.budget.js).toBe('${RESOURCE_PAGE_BUDGET}');
});
`;
};

/** The resource's `page.tsx` and its unit test. The stylesheet, e2e test and catalog are `x g route`'s. */
export const resourcePageFiles = (options: ResourcePageOptions): readonly GeneratedFile[] => [
  { path: `${options.pageDir}/page.tsx`, contents: pageSource(options) },
  { path: `${options.pageDir}/page.test.ts`, contents: pageTest(options) },
];
