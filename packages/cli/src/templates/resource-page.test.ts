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
    expect(page).toContain("import { widgetList } from '../widget/live/widget-list';");
    // The read's tenancy is the actor's, held by the query — never an input the page fills.
    expect(page).toContain('const input = () => ({ limit: PAGE_ROWS });');
    expect(page).not.toContain('orgId');
    expect(page).toContain("src: '../widget/widget-form.island.tsx',");
    expect(page).toContain("endpoint={derivePath('createWidget').path}");
    expect(page).toContain(`budget: { js: '${RESOURCE_PAGE_BUDGET}' },`);
    // The budget names its measurement, in the form `bun run budget-raises` reads.
    expect(page).toMatch(/\/\/ measured: [\d,]+ B .*\n.*why:/);
  });

  test('the load line breaks after the arrow, as Biome does, once the name makes it too wide', () => {
    expect(pageOf('widget', true)).toContain(
      'const load = (): Promise<PageData> => rowsState(() => widgetList(input()));',
    );
    const long = pageOf('quarterly-subscription-invoice-reconciliation-line', true);
    expect(long).toContain('const load = (): Promise<PageData> =>\n  rowsState(() =>');
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
    expect(MEASURE_PAGE).toBe('bunx x build --target static && bunx x verify --only budgets');
  });

  test('an entity alone owes the migration and nothing to weigh', () => {
    expect(nextSteps(['apps/web/app/widget/entity.ts'], [], table)).toEqual([
      'bunx x db gen "create widgets"',
      'bunx x db migrate',
    ]);
  });
});
