// `x g resource <name>`'s page: the plural route a slice is reached at. It READS — a `<Hole>` calls
// the slice's own query a page at a time as the request's actor, after the shell left — renders the
// rows in a link-mode `DataTable` (loading, failed, empty, ready; paged by URL, no script), and
// mounts the slice's form island. `x g route`
// writes a page with a heading and nothing to read; a resource has rows and a form, and a page
// that showed neither was a slice nobody could reach without wiring it by hand.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { titleKey } from './naming';
import { formIslandSpecifier } from './resource-form-island';
import { pageDbTest } from './resource-page-db';
import { LINE_WIDTH, wrapImport } from './wrap';

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

/** The read in `rows()`, as Biome prints it at any name length. */
const stateLine = (read: string): string => {
  const line = `  const state = await rowsState(() => ${read}.page(inputOf(list), windowOf(list)));`;
  return line.length <= LINE_WIDTH
    ? line
    : `  const state = await rowsState(() =>\n    ${read}.page(inputOf(list), windowOf(list)),\n  );`;
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
  const translator = options.catalogModule === undefined ? '' : '\n  const t = useT();\n';
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
  return `// /${path}: the org's ${feature.pluralKebab}, newest first, and the form that adds one.
// The rows are read inside a \`<Hole>\`, through the slice's own query, so the shell and the form
// are on screen before the read answers; the policy, the tenancy and the order are the query's.
// The pager is links (\`listUrl\`), so paging needs no script; the form is the slice's island, the
// one module of this page a browser downloads.

${sortedImports([
  ...i18nImports(options.catalogModule),
  "import { derivePath } from '@ultimat3/action';",
  "import type { AsyncState, Page as RowPage } from '@ultimat3/core';",
  "import type { KnownPermission } from '@ultimat3/policy';",
  "import { defineRoute, Hole, island } from '@ultimat3/render';",
  "import {\n  DataTable,\n  type ListUrl,\n  listUrl,\n  Money,\n  PageHeader,\n  Section,\n  Skeleton,\n} from '@ultimat3/ui';",
])}
${options.shell ? "import { Shell } from '../../shared/shell';\n" : ''}import type { ${feature.pascal} } from '../${feature.kebab}/entity';
${wrapImport([list, `${list}Sorts`], `../${feature.kebab}/live/${feature.kebab}-list`)}
import styles from './page.module.scss';

/** The most rows one page shows; \`?limit=\` may ask for fewer, never more. */
const PAGE_ROWS = 50;

/** The currency a price is typed in; the form sends integer minor units of it. */
const CURRENCY = 'USD';

type Row = ${feature.pascal};

/** The read's outcome as DATA, so the table renders each of its states. */
export type PageData = AsyncState<RowPage<Row>>;

/**
 * The read, as a state. A refusal, a failed read or a stale cursor is the table's error branch —
 * code, cause and fix on screen, the form still there — never a 500 for the whole document.
 */
export async function rowsState(read: () => Promise<RowPage<Row>>): Promise<PageData> {
  try {
    return { status: 'ready', data: await read() };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/** The list's state in the URL: a sort among the query's own columns, a cursor, a page size. */
type ListState = ListUrl<(typeof ${list}Sorts)[number]>;

const listOf = (url: string | undefined): ListState =>
  listUrl(url ?? '/${path}', {
    sorts: ${list}Sorts,
    limit: { default: PAGE_ROWS, max: PAGE_ROWS },
  });

/**
 * No org: the query reads the ACTOR's, so a read can only ever be for the caller's own org. No
 * sort in the URL is the query's own order, newest first; a cursor is minted for one sort alone,
 * and \`listUrl\` drops it whenever the sort changes.
 */
const inputOf = (list: ListState) =>
  list.sort === undefined
    ? { limit: PAGE_ROWS }
    : { limit: PAGE_ROWS, sort: list.sort.key, dir: list.sort.direction };

/** The page the URL names: its size, and the cursor it reads after when it is not the first. */
const windowOf = (list: ListState) =>
  list.cursor === undefined ? { first: list.limit } : { first: list.limit, after: list.cursor };

/** The rows, once they are read. Called by the \`<Hole>\`: it starts after the first flush. */
async function rows(list: ListState) {${translator}
${stateLine(list)}
  const page = state.status === 'ready' ? state.data : undefined;
  return (
    <DataTable
      caption={t('${titleKey(path)}')}
      rows={page?.rows ?? []}
      rowKey={(row: Row) => row.id}
      error={state.status === 'failed' ? state.error : undefined}
      emptyTitle={t('app.${feature.kebab}.empty')}
      columns={[
        {
          key: 'title',
          header: t('app.${feature.kebab}.titleLabel'),
          sortable: true,
          cell: (row) => row.title,
        },
        {
          key: 'price',
          header: t('app.${feature.kebab}.priceLabel'),
          numeric: true,
          cell: (row) => <Money value={row.price} />,
        },
      ]}
      sort={list.sort}
      sortHrefFor={list.sortHrefFor}
      nextCursor={page?.nextCursor}
      hrefFor={list.hrefFor}
      firstHref={list.firstHref}
    />
  );
}

// Declared ABOVE \`defineRoute\`: the route drains the islands declared before it. Named by
// SPECIFIER, never imported — a string has no import edge, so the page's bundle graph stays the
// page's (axiom 6). \`props\` are exactly the form's \`${feature.pascal}FormProps\` keys.
const ${feature.pascal}Form = island({
  src: '${formIslandSpecifier(feature, options.dir, options.pageDir)}',
  props: ['endpoint', 'locale', 'currency', 'labels'],
});

export const config = defineRoute({
  render: 'stream',
  hydrate: 'visible',
  offline: 'runtime',
  // An org's rows are not public: a route with no policy registers \`auth: 'public'\` and its
  // response carries no \`vary: cookie\`. Which ORG is the query's decision, on every read.
  policy: { permission: '${feature.kebab}:read' satisfies KnownPermission },
  // measured: ${RESOURCE_PAGE_MEASURED} (\`x build --target static\`, Bun 1.4.0) — the form island and the
  // \`visible\` runtime. why: the form is Solid, @ultimat3/ui's Form/Input/Button and the transport.
  // A raise states its own measured bytes and why here, in the same diff (\`X_BUDGET_EXCEEDED\`).
  budget: { js: '${RESOURCE_PAGE_BUDGET}' },
  meta: ({ t }) => ({
    title: t('${titleKey(path)}'),
    description: t('${titleKey(path).replace('.title', '.description')}'),
  }),
});

export function Page(props: { readonly url?: string | undefined }) {${options.catalogModule === undefined ? '' : '\n  const t = useT();\n'}
  const list = listOf(props.url);
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
<Hole fallback={<Skeleton lines={3} />}>{() => rows(list)}</Hole>`)}
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
  return `// /${feature.pluralKebab}, rendered as a request renders it, with the \`<Hole>\` awaited in line: the
// read names the actor's org through the slice's query — the in-memory driver under test — and the
// page shows the rows, the empty state or the refusal, with the form island beside them in each.
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
  expect(view.text).toContain('newer');
  expect(view.text.indexOf('newer')).toBeLessThan(view.text.indexOf('older'));
  // The form is the one island, and it wakes when it is visible.
  expect(view.islands.map((island) => island.strategy)).toEqual(['visible']);
  expect(view.islands[0]?.moduleId).toContain('${feature.kebab}-form');
});

unitTest('an org with no rows reads the empty state, not an empty list', async () => {${t}
  const view = await renderRoute(page, { url, actor: member });
  expect(view.text).toContain(t('app.${feature.kebab}.empty'));
  expect(view.meta.title).toBe(t('${titleKey(feature.pluralKebab)}'));
});

unitTest('a member of another org reads none of this org’s rows', async () => {${t}
  await store('ours');
  // The same page, the same URL: which org it reads is the actor's, never a parameter.
  const outsider = testActor('outsider', { orgId: otherOrg, permissions: [read] }).actor;
  const view = await renderRoute(page, { url, actor: outsider });
  expect(view.text).not.toContain('ours');
  expect(view.text).toContain(t('app.${feature.kebab}.empty'));
});

unitTest('a caller the read refuses sees the refusal, and the page around it', async () => {
  // In the org, without the grant: the query's policy refuses before any row is read.
  const stranger = testActor('stranger', { orgId }).actor;
  const view = await renderRoute(page, { url, actor: stranger });
  expect(view.html).toContain('X_FORBIDDEN');
  expect(view.islands).toHaveLength(1);
});

/** The anchor a pager side renders, read off the HTML: \`rel\` names the side. */
const linkTo = (html: string, rel: string): string | undefined => {
  const anchor = new RegExp(\`<a\\\\b[^>]*\\\\brel="\${rel}"[^>]*>\`).exec(html)?.[0];
  return /href="([^"]*)"/.exec(anchor ?? '')?.[1]?.replaceAll('&amp;', '&');
};

unitTest('the list pages by link: a cursor in the URL, no script', async () => {
  await store('older');
  clock.advance(1000);
  await store('newer');
  const first = await renderRoute(page, { url: \`\${url}?limit=1\`, actor: member });
  expect(first.text).toContain('newer');
  expect(first.text).not.toContain('older');
  // The first page has nowhere back to, and a keyset page has no Previous.
  expect(first.html).not.toContain('href="/${feature.pluralKebab}?limit=1"');
  expect(linkTo(first.html, 'prev')).toBeUndefined();
  const next = linkTo(first.html, 'next');
  expect(next).toContain('after=');

  const second = await renderRoute(page, { url: new URL(next ?? '', url).href, actor: member });
  expect(second.text).toContain('older');
  expect(second.text).not.toContain('newer');
  // The last page links back to the first and on to nothing, never to \`after=null\`.
  expect(second.html).toContain('href="/${feature.pluralKebab}?limit=1"');
  expect(linkTo(second.html, 'next')).toBeUndefined();
  expect(second.html).not.toContain('after=null');
});

unitTest('the list sorts by link, and a sorted list pages in that order', async () => {
  // Written so that newest-first and by-title disagree: a sort applied after the bound would show
  // the two newest re-sorted, never the first two titles.
  for (const title of ['beta', 'gamma', 'alpha']) {
    await store(title);
    clock.advance(1000);
  }
  const sorted = \`\${url}?sort=title&dir=asc&limit=2\`;
  const first = await renderRoute(page, { url: sorted, actor: member });
  expect(first.text.indexOf('alpha')).toBeLessThan(first.text.indexOf('beta'));
  expect(first.text).not.toContain('gamma');
  // The header links on to the next state of its cycle, the cursor dropped with the old order.
  const descending = 'href="/${feature.pluralKebab}?sort=title&amp;dir=desc&amp;limit=2"';
  expect(first.html).toContain(descending);
  const next = linkTo(first.html, 'next');
  expect(next).toContain('sort=title');
  const second = await renderRoute(page, { url: new URL(next ?? '', url).href, actor: member });
  expect(second.text).toContain('gamma');
  expect(second.text).not.toContain('alpha');
});

unitTest('it is gated, rendered per request, and budgeted', () => {
  expect(page.config.render).toBe('stream');
  expect(page.config.policy?.permission).toBe(read);
  expect(page.config.offline).toBe('runtime');
  expect(page.config.budget.js).toBe('${RESOURCE_PAGE_BUDGET}');
});
`;
};

/**
 * The resource's `page.tsx`, its unit test, and the same read over the migrated database. The
 * stylesheet, e2e test and catalog are `x g route`'s.
 */
export const resourcePageFiles = (options: ResourcePageOptions): readonly GeneratedFile[] => [
  { path: `${options.pageDir}/page.tsx`, contents: pageSource(options) },
  { path: `${options.pageDir}/page.test.ts`, contents: pageTest(options) },
  { path: `${options.pageDir}/page-db.test.ts`, contents: pageDbTest(options) },
];
