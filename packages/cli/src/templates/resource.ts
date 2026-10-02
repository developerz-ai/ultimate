// `x g resource <name>` — the whole feature slice in one command: entity, repo, service, policy,
// two actions, a live list query, a UI component and a route, each with a passing test. This is
// the blessed path; the individual generators exist for adding to a slice that already exists.

import { actionFiles } from './action';
import { adminFiles } from './admin';
import { adminCatalogEntries } from './admin-catalog';
import { catalogJson } from './catalog-json';
import type { FeatureTarget } from './entity';
import { entityFiles } from './entity';
import { sortedImports } from './imports';
import { jobFiles } from './job';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { policyFiles } from './policy';
import { queryFiles } from './query';
import { resourceCreateFiles } from './resource-create';
import { formIslandFiles } from './resource-form-island';
import { resourcePageFiles } from './resource-page';
import { serviceFiles } from './resource-service';
import { routeDir, routeFiles } from './route';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';

/**
 * The generated component reaches strings through the APP's catalog module — the one that calls
 * `defineCatalogs()` — so a component that renders a string depends on the module that registers
 * them. `t` from `@ultimat3/i18n` renders while depending on nothing, which is how a shipped app
 * served every string as a loud miss with a green gate (issue #249). An app with no catalog module
 * keeps the framework import: emitting one that cannot resolve is worse than the wrong idiom.
 */
const catalogImport = (module: string | undefined): string =>
  module === undefined
    ? "import { t } from '@ultimat3/i18n';"
    : `import { useT } from '${module}';`;

/** `useT()` is per render, so each component binds it in its own body. */
const translatorBinding = (module: string | undefined): string =>
  module === undefined ? '' : '\n  const t = useT();\n';

const uiSource = (
  feature: NameSet,
  module: string | undefined,
): string => `// Presentation only. No fetching, no business logic: the list arrives as a prop from the route,
// which got it from the live query.

${catalogImport(module)}
import { For } from 'solid-js';
import type { ${feature.pascal} } from './entity';
import styles from './ui.module.scss';

export interface ${feature.pascal}ListProps {
  readonly rows: readonly ${feature.pascal}[];
}

export function ${feature.pascal}List(props: ${feature.pascal}ListProps) {${translatorBinding(module)}
  return (
    <ul class={styles.list}>
      <For each={props.rows} fallback={<li>{t('app.${feature.kebab}.empty')}</li>}>
        {/* <For> is keyed by value identity, so the item arrives directly and a row is only
            re-created when its value changes. <Index> is the accessor-shaped one — reach for it
            when the list is a fixed set of slots whose contents mutate. */}
        {(row) => <li class={styles.item}>{row.title}</li>}
      </For>
    </ul>
  );
}
`;

const uiStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.list {
  display: grid;
  gap: tokens.space(2);
}

.item {
  padding: tokens.space(2);
  border-radius: tokens.radius('sm');
  background: tokens.role('surface-raised');
  color: tokens.role('fg');
}
`;

const cardSource = (
  feature: NameSet,
  module: string | undefined,
): string => `// One ${feature.camel} rendered on its own — the list's \`item\` shown outside a list, so a
// detail route and a search result render the identical markup.

${catalogImport(module)}
import type { ${feature.pascal} } from '../entity';
import styles from '../ui.module.scss';

export interface ${feature.pascal}CardProps {
  readonly row: ${feature.pascal};
}

export function ${feature.pascal}Card(props: ${feature.pascal}CardProps) {${translatorBinding(module)}
  return (
    <article class={styles.item}>
      <h3>{props.row.title}</h3>
      <p>{t('app.${feature.kebab}.updated')}</p>
    </article>
  );
}
`;

const uiTest = (
  feature: NameSet,
  module: string | undefined,
): string => `// The ${feature.kebab} list and card, rendered the way a page renders them. What a typecheck
// cannot see is which branch a prop picks, and whether the words on screen are the catalog's.
${sortedImports([catalogImport(module), "import { expect, renderView, unitTest } from '@ultimat3/testing';"])}
import type { ${feature.pascal} } from './entity';
import { ${feature.pascal}List } from './ui';
import { ${feature.pascal}Card } from './ui/${feature.kebab}-card';

const titled = (title: string): ${feature.pascal} => ({
  id: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  title,
  price: { minor: 1200, currency: 'USD' },
  createdAt: new Date(0),
});

unitTest('the list renders one item per row, in the order it was given', async () => {
  const rows = [titled('first'), titled('second')];
  const view = await renderView(${feature.pascal}List, { rows });
  expect(view.html.match(/<li\\b/g)).toHaveLength(2);
  expect(view.text).toBe('first second');
});

unitTest('with no rows the list says so, in one item', async () => {${module === undefined ? '' : '\n  const t = useT();'}
  const view = await renderView(${feature.pascal}List, { rows: [] });
  expect(view.html.match(/<li\\b/g)).toHaveLength(1);
  expect(view.text).toBe(t('app.${feature.kebab}.empty'));
});

unitTest('the card renders the row it is given, under its own heading', async () => {${module === undefined ? '' : '\n  const t = useT();'}
  const view = await renderView(${feature.pascal}Card, { row: titled('on a card') });
  expect(view.html).toContain('<h3>on a card</h3>');
  expect(view.text).toContain(t('app.${feature.kebab}.updated'));
});
`;

// The admin's keys are always here, `--admin` or not: the entity is an admin screen the moment it
// joins the handle, and that screen reads `admin.<table>.title` and a label per column
// (`admin-catalog.ts`). A missing key renders ⟦key⟧ in the list's own header.
const catalogSource = (feature: NameSet, admin: Readonly<Record<string, string>>): string =>
  catalogJson({
    [`app.${feature.kebab}.empty`]: `No ${feature.pluralKebab} yet.`,
    [`app.${feature.kebab}.updated`]: 'Last updated',
    [`app.${feature.kebab}.titleLabel`]: 'Title',
    [`app.${feature.kebab}.priceLabel`]: 'Price',
    [`app.${feature.kebab}.new`]: `New ${feature.kebab.replaceAll('-', ' ')}`,
    [`app.${feature.kebab}.submit`]: 'Save',
    [`app.${feature.kebab}.saved`]: 'Saved',
    [`app.${feature.kebab}.retry`]: 'Try again',
    ...admin,
  });

export interface ResourceOptions extends FeatureTarget {
  /** `x g resource post --admin` — also emits the per-entity admin override. */
  readonly admin?: boolean;
  /** Every locale the feature's catalog ships for. Defaults to `['en']`. */
  readonly locales?: readonly string[];
  /**
   * The app's own catalog module — `@<app>/i18n`, read off `packages/i18n/package.json` by
   * `resolveCatalogModule`. Absent only for an app that ships no such package.
   */
  readonly catalogModule?: string;
  /**
   * The app has `apps/web/shared/shell.tsx`, the frame `x new` writes, for the page to sit in —
   * read off the disk by `x g`. Absent is no: a generation imports only what it writes or what the
   * caller said is there (`slice-foundation.test.ts`), and the page is then its own `<main>`.
   */
  readonly shell?: boolean;
}

export function resourceFiles(rawName: string, target: ResourceOptions): readonly GeneratedFile[] {
  const feature = names(rawName);
  // `dbModule` travels with the slice: every generator composed below may write the slice's
  // `repo.ts`, and one that lost the app's name would import the handle from a placeholder.
  const slice: FeatureTarget = {
    surfaceDir: target.surfaceDir,
    feature: feature.kebab,
    ...(target.dbModule === undefined ? {} : { dbModule: target.dbModule }),
  };
  const dir = `${slice.surfaceDir}/${slice.feature}`;
  // The page this same call writes, from the function that decides where a route goes — the island
  // specifier is resolved against it, so re-deriving the path here would be two answers to one
  // question and only one of them reaches `routeFiles`.
  const dbModule = target.dbModule ?? PLACEHOLDER_DB_MODULE;
  const pageDir = routeDir('app', feature.pluralKebab);
  const locales = resolveLocales(target.locales);
  const entity = entityFiles(rawName, slice);
  // The entity this same call writes, handed to the generators composed below as if it were on
  // disk: they write into a slice that HAS data, so they read it rather than a neutral body.
  const sliceEntity = String(entity.find((file) => file.path.endsWith('/entity.ts'))?.contents);
  return [
    ...entity,
    ...policyFiles(rawName, slice),
    // Not `x g action`'s body: a resource's create INSERTS (`resource-create.ts`).
    ...resourceCreateFiles(rawName, dir, dbModule),
    // `sliceEntity` is this run's own, so the action's test stores a row and runs its handler
    // against the repo beside it.
    ...actionFiles(`archive-${feature.kebab}`, { ...slice, sliceEntity }),
    // And the read's test stores rows through that same repo, then reads them back in order.
    ...queryFiles(`${feature.camel}List`, { ...slice, live: true, sliceEntity }),
    ...jobFiles(`reindex-${feature.kebab}`, { ...slice, sliceEntity }),
    ...serviceFiles(feature, dir, dbModule),
    { path: `${dir}/ui.tsx`, contents: uiSource(feature, target.catalogModule) },
    // Beside the two components it renders: a generated module with no test is uncovered source
    // in an app whose gate holds a coverage floor.
    { path: `${dir}/ui.test.ts`, contents: uiTest(feature, target.catalogModule) },
    { path: `${dir}/ui.module.scss`, contents: uiStyle() },
    {
      path: `${dir}/ui/${feature.kebab}-card.tsx`,
      contents: cardSource(feature, target.catalogModule),
    },
    ...formIslandFiles(feature, dir, pageDir),
    ...locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogSource(feature, adminCatalogEntries(rawName, slice)),
      merge: 'json' as const,
    })),
    // Always an app route: a slice ships a live query, a form island and actions, and `generate()`
    // refuses `--surface site` for a resource. The stylesheet, the offline e2e test and the
    // title/description keys are `x g route`'s; the page and its unit test are the resource's
    // own (`resource-page.ts`) — they read the rows and mount the form, which a route cannot.
    ...routeFiles(feature.pluralKebab, {
      surface: 'app',
      locales,
      ...(target.catalogModule === undefined ? {} : { catalogModule: target.catalogModule }),
    }).filter((file) => !/\/page\.(tsx|test\.ts)$/.test(file.path)),
    ...resourcePageFiles({
      feature,
      dir,
      pageDir,
      shell: target.shell === true,
      dbModule,
      ...(target.catalogModule === undefined ? {} : { catalogModule: target.catalogModule }),
    }),
    ...(target.admin === true ? adminFiles(rawName, slice) : []),
  ];
}
