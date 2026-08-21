// `x g resource <name>` — the whole feature slice in one command: entity, repo, service, policy,
// two actions, a live list query, a UI component and a route, each with a passing test. This is
// the blessed path; the individual generators exist for adding to a slice that already exists.

import { actionFiles } from './action';
import { adminFiles } from './admin';
import { catalogJson } from './catalog-json';
import type { FeatureTarget } from './entity';
import { entityFiles } from './entity';
import { jobFiles } from './job';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile, NameSet } from './naming';
import { names, pascal } from './naming';
import { policyFiles } from './policy';
import { queryFiles } from './query';
import { formIslandFiles } from './resource-form-island';
import { routeDir, routeFiles } from './route';

const serviceSource = (
  feature: NameSet,
): string => `// Business logic for ${feature.pluralKebab}. Knows nothing about HTTP or requests, so a job and an
// action can both call it. Takes values, not a request.

import type { ${feature.pascal} } from './entity';
import { ${feature.pascal}NotFoundError } from './errors';
import * as repo from './repo';

/** Derived from the row, never restated: a new column reaches this input without an edit here. */
export type Create${feature.pascal}Input = Omit<${feature.pascal}, 'id' | 'createdAt'>;

/** The row, aliased once, so every signature below reads at one width whatever the feature is
 * called — a generated file the app's own formatter rewrites is a red \`lint\` over code nobody
 * typed. */
type Row = ${feature.pascal};

export async function create(input: Create${feature.pascal}Input): Promise<Row> {
  return repo.insert(input);
}

export async function require${feature.pascal}(id: string): Promise<Row> {
  const row = await repo.byId(id);
  if (row === undefined) throw new ${feature.pascal}NotFoundError({ id });
  return row;
}
`;

const serviceTest = (
  feature: NameSet,
): string => `// The ${feature.kebab} feature's failure, pinned: a code an agent can match on, a cause naming
// the row, and a fix that is an instruction. A bare Error would satisfy none of the three.
import { expect, unitTest } from '@ultimat3/testing';
import { ${feature.pascal}NotFoundError } from './errors';

unitTest('${feature.pascal}NotFoundError carries a code, a cause and a fix', () => {
  const error = new ${feature.pascal}NotFoundError({ id: 'missing' });
  expect(error).toBeUltimateError('X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND');
  expect(error.cause).toContain('missing');
  expect(error.fix.length).toBeGreaterThan(0);
});
`;

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

// `admin.<feature>.title` is always here, `--admin` or not: `defineAdmin()` resolves that key the
// moment anyone writes the override, and a missing key renders ⟦key⟧ and fails the i18n gate,
// while an unused key is only ever reported (`auditCatalogs` fails on `missing`, never `unused`).
const catalogSource = (feature: NameSet): string =>
  catalogJson({
    [`app.${feature.kebab}.empty`]: `No ${feature.pluralKebab} yet.`,
    [`app.${feature.kebab}.updated`]: 'Last updated',
    [`app.${feature.kebab}.titleLabel`]: 'Title',
    [`app.${feature.kebab}.submit`]: 'Save',
    [`app.${feature.kebab}.saved`]: 'Saved',
    [`app.${feature.kebab}.retry`]: 'Try again',
    [`admin.${feature.kebab}.title`]: pascal(feature.plural),
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
}

export function resourceFiles(rawName: string, target: ResourceOptions): readonly GeneratedFile[] {
  const feature = names(rawName);
  const slice: FeatureTarget = { surfaceDir: target.surfaceDir, feature: feature.kebab };
  const dir = `${slice.surfaceDir}/${slice.feature}`;
  // The page this same call writes, from the function that decides where a route goes — the island
  // specifier is resolved against it, so re-deriving the path here would be two answers to one
  // question and only one of them reaches `routeFiles`.
  const pageDir = routeDir('app', feature.pluralKebab);
  const locales = resolveLocales(target.locales);
  return [
    ...entityFiles(rawName, slice),
    ...policyFiles(rawName, slice),
    ...actionFiles(`create-${feature.kebab}`, slice),
    ...actionFiles(`archive-${feature.kebab}`, slice),
    ...queryFiles(`${feature.camel}List`, { ...slice, live: true }),
    ...jobFiles(`reindex-${feature.kebab}`, slice),
    { path: `${dir}/service.ts`, contents: serviceSource(feature) },
    { path: `${dir}/service.test.ts`, contents: serviceTest(feature) },
    { path: `${dir}/ui.tsx`, contents: uiSource(feature, target.catalogModule) },
    { path: `${dir}/ui.module.scss`, contents: uiStyle() },
    {
      path: `${dir}/ui/${feature.kebab}-card.tsx`,
      contents: cardSource(feature, target.catalogModule),
    },
    ...formIslandFiles(feature, dir, pageDir),
    ...locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogSource(feature),
      merge: 'json' as const,
    })),
    // Always an app route: a slice ships a live query, a form island and actions, and `generate()`
    // refuses `--surface site` for a resource rather than emit them behind a 0kb budget.
    //
    // `catalogModule` travels with it. It did not, so the page a RESOURCE writes imported `t` from
    // `@ultimat3/i18n` while the components beside it imported `useT` from the app's own catalog
    // module — one command, two idioms, and the framework-import one is issue #249's: it renders
    // strings while depending on nothing that registers them.
    ...routeFiles(feature.pluralKebab, {
      surface: 'app',
      locales,
      ...(target.catalogModule === undefined ? {} : { catalogModule: target.catalogModule }),
    }),
    ...(target.admin === true ? adminFiles(rawName, slice) : []),
  ];
}
