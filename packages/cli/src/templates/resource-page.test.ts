// The resource's page as text: which frame it sits in, the budget it declares, the read it makes,
// and the command `x g` prints so the budget is weighed on the run that wrote it. Whether the page
// RENDERS is its own emitted `page.test.ts`, run inside a scaffolded app.

import { describe, expect, test } from 'bun:test';
import { MEASURE_PAGE, nextSteps } from '../cmd-generate';
import { names } from './naming';
import { RESOURCE_PAGE_BUDGET, resourcePageFiles } from './resource-page';

const pageOf = (name: string, shell: boolean): string => {
  const feature = names(name);
  const files = resourcePageFiles({
    feature,
    dir: `apps/web/app/${feature.kebab}`,
    pageDir: `apps/web/app/${feature.pluralKebab}`,
    shell,
    dbModule: '@acme/db',
    catalogModule: '@acme/i18n',
  });
  return String(files.find((file) => file.path.endsWith('/page.tsx'))?.contents);
};

describe('unit · the resource page', () => {
  test('inside the app frame when the app has one, its own <main> when it does not', () => {
    const framed = pageOf('widget', true);
    expect(framed).toContain("import { Shell } from '../../shared/shell';");
    expect(framed).toContain('<Shell>');
    expect(framed).not.toContain('<main');
    const bare = pageOf('widget', false);
    expect(bare).not.toContain('shared/shell');
    expect(bare).toContain('<main class={styles.page}>');
  });

  test('it reads through the slice query as the actor, and mounts the slice form', () => {
    const page = pageOf('widget', true);
    expect(page).toContain(
      "import { widgetList, widgetListSorts } from '../widget/live/widget-list';",
    );
    // The read's tenancy is the actor's, held by the query — never an input the page fills.
    expect(page).toContain('? { limit: PAGE_ROWS }');
    expect(page).not.toContain('orgId');
    expect(page).toContain("src: '../widget/widget-form.island.tsx',");
    expect(page).toContain("endpoint={derivePath('createWidget').path}");
    expect(page).toContain(`budget: { js: '${RESOURCE_PAGE_BUDGET}' },`);
    // The budget names its measurement, in the form `bun run budget-raises` reads.
    expect(page).toMatch(/\/\/ measured: [\d,]+ B .*\n.*why:/);
  });

  test('the read lives in a thunk of a <Hole>, on stream, and nothing is left in load', () => {
    const page = pageOf('widget', true);
    expect(page).toContain("render: 'stream',");
    expect(page).toContain('<Hole fallback={<Skeleton lines={3} />}>{() => rows(list)}</Hole>');
    expect(page).not.toMatch(/^\s*load[,:]/m);
    expect(page).not.toContain('props.data');
  });

  test('the read line breaks as Biome does, once the name makes it too wide', () => {
    expect(pageOf('widget', true)).toContain(
      '  const state = await rowsState(() => widgetList.page(inputOf(list), windowOf(list)));',
    );
    const long = pageOf('quarterly-subscription-invoice-reconciliation-line-item', true);
    expect(long).toContain(
      '  const state = await rowsState(() =>\n    quarterlySubscriptionInvoiceReconciliationLineItemList.page(inputOf(list), windowOf(list)),\n  );',
    );
  });
});

describe('unit · the list pages by link', () => {
  test('the URL is read through listUrl, with the read’s own bound as the ceiling', () => {
    const page = pageOf('widget', true);
    expect(page).toContain('listUrl,');
    expect(page).toContain('const list = listOf(props.url);');
    expect(page).toContain('limit: { default: PAGE_ROWS, max: PAGE_ROWS },');
  });

  test('it sorts by link, over the query’s own closed set of columns', () => {
    const page = pageOf('widget', true);
    expect(page).toContain('sorts: widgetListSorts,');
    expect(page).toContain('sortHrefFor={list.sortHrefFor}');
    expect(page).toContain('sort={list.sort}');
    expect(page).toContain(
      ': { limit: PAGE_ROWS, sort: list.sort.key, dir: list.sort.direction };',
    );
  });

  test('a link-mode DataTable: a Page handed through, the pager as anchors, no island for it', () => {
    const page = pageOf('widget', true);
    expect(page).toContain('<DataTable');
    expect(page).toContain('nextCursor={page?.nextCursor}');
    expect(page).toContain('hrefFor={list.hrefFor}');
    expect(page).toContain('firstHref={list.firstHref}');
    expect(page).not.toContain('onCursor');
    // The form is the page's only island; paging adds none.
    expect(page.match(/island\(\{/g)).toHaveLength(1);
  });

  test('its own test follows the next link and lands on the last page', () => {
    const feature = names('widget');
    const files = resourcePageFiles({
      feature,
      dir: 'apps/web/app/widget',
      pageDir: 'apps/web/app/widgets',
      shell: true,
      dbModule: '@acme/db',
    });
    const test = String(files.find((file) => file.path.endsWith('/page.test.ts'))?.contents);
    expect(test).toContain("unitTest('the list pages by link: a cursor in the URL, no script'");
    expect(test).toContain("expect(second.html).not.toContain('after=null');");
  });
});

describe('unit · what x g prints after a resource', () => {
  const table = 'widgets';

  test('a run that wrote a page ends by weighing it', () => {
    const written = ['apps/web/app/widget/entity.ts', 'apps/web/app/widgets/page.tsx'];
    expect(nextSteps(written, [], table)).toEqual([
      'bunx x db gen "create widgets"',
      'bunx x db migrate',
      MEASURE_PAGE,
    ]);
    // One command: `budgets` builds when the page is newer than the stats (plan 101, 21).
    expect(MEASURE_PAGE).toBe('bunx x verify --only budgets');
  });

  test('an entity alone owes the migration and nothing to weigh', () => {
    expect(nextSteps(['apps/web/app/widget/entity.ts'], [], table)).toEqual([
      'bunx x db gen "create widgets"',
      'bunx x db migrate',
    ]);
  });
});
