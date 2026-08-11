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
import { routeFiles } from './route';

const serviceSource = (
  feature: NameSet,
): string => `// Business logic for ${feature.pluralKebab}. Knows nothing about HTTP or requests, so a job and an
// action can both call it. Takes values, not a request.

import type { ${feature.pascal} } from './entity';
import { ${feature.pascal}NotFoundError } from './errors';
import * as repo from './repo';

/** Derived from the row, never restated: a new column reaches this input without an edit here. */
export type Create${feature.pascal}Input = Omit<${feature.pascal}, 'id' | 'createdAt'>;

export async function create(input: Create${feature.pascal}Input): Promise<${feature.pascal}> {
  return repo.insert(input);
}

export async function require${feature.pascal}(id: string): Promise<${feature.pascal}> {
  const row = await repo.byId(id);
  if (row === undefined) throw new ${feature.pascal}NotFoundError({ id });
  return row;
}
`;

const serviceTest = (
  feature: NameSet,
): string => `import { expect, unitTest } from '@ultimat3/testing';
import { ${feature.pascal}NotFoundError } from './errors';

unitTest('${feature.pascal}NotFoundError carries a code, a cause and a fix', () => {
  const error = new ${feature.pascal}NotFoundError({ id: 'missing' });
  expect(error).toBeUltimateError('X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND');
  expect(error.cause).toContain('missing');
  expect(error.fix.length).toBeGreaterThan(0);
});
`;

const uiSource = (
  feature: NameSet,
): string => `// Presentation only. No fetching, no business logic: the list arrives as a prop from the route,
// which got it from the live query.

import { t } from '@ultimat3/i18n';
import { For } from 'solid-js';
import type { ${feature.pascal} } from './entity';
import styles from './ui.module.scss';

export interface ${feature.pascal}ListProps {
  readonly rows: readonly ${feature.pascal}[];
}

export function ${feature.pascal}List(props: ${feature.pascal}ListProps) {
  return (
    <ul class={styles.list}>
      <For each={props.rows} fallback={<li>{t('app.${feature.kebab}.empty')}</li>}>
        {/* The item arrives as an accessor: reading it inside the row is what keeps the update
            surgical instead of re-rendering the list. */}
        {(row) => <li class={styles.item}>{row().title}</li>}
      </For>
    </ul>
  );
}
`;

const uiStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.list {
  display: grid;
  gap: tokens.$space-2;
}

.item {
  padding: tokens.$space-2;
  border-radius: tokens.$radius-sm;
  background: tokens.$surface-raised;
  color: tokens.$text-primary;
}
`;

const cardSource = (
  feature: NameSet,
): string => `// One ${feature.camel} rendered on its own — the list's \`item\` shown outside a list, so a
// detail route and a search result render the identical markup.

import { t } from '@ultimat3/i18n';
import type { ${feature.pascal} } from '../entity';
import styles from '../ui.module.scss';

export interface ${feature.pascal}CardProps {
  readonly row: ${feature.pascal};
}

export function ${feature.pascal}Card(props: ${feature.pascal}CardProps) {
  return (
    <article class={styles.item}>
      <h3>{props.row.title}</h3>
      <p>{t('app.${feature.kebab}.updated')}</p>
    </article>
  );
}
`;

const formSource = (
  feature: NameSet,
): string => `// Presentation only: the mutator this submits to owns validation server-side, so this form
// never re-implements the invariant — a blank title fails at the boundary, not in the DOM.

import { t } from '@ultimat3/i18n';
import { createSignal } from 'solid-js';
import styles from '../ui.module.scss';

export interface ${feature.pascal}FormProps {
  readonly onSubmit: (title: string) => void;
}

export function ${feature.pascal}Form(props: ${feature.pascal}FormProps) {
  const [title, setTitle] = createSignal('');
  return (
    <form
      class={styles.item}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(title());
      }}
    >
      <label>
        {t('app.${feature.kebab}.titleLabel')}
        <input value={title()} onInput={(event) => setTitle(event.currentTarget.value)} />
      </label>
      <button type="submit">{t('app.${feature.kebab}.submit')}</button>
    </form>
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
    [`admin.${feature.kebab}.title`]: pascal(feature.plural),
  });

export interface ResourceOptions extends FeatureTarget {
  /** `x g resource post --admin` — also emits the per-entity admin override. */
  readonly admin?: boolean;
  /** Every locale the feature's catalog ships for. Defaults to `['en']`. */
  readonly locales?: readonly string[];
}

export function resourceFiles(rawName: string, target: ResourceOptions): readonly GeneratedFile[] {
  const feature = names(rawName);
  const slice: FeatureTarget = { surfaceDir: target.surfaceDir, feature: feature.kebab };
  const dir = `${slice.surfaceDir}/${slice.feature}`;
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
    { path: `${dir}/ui.tsx`, contents: uiSource(feature) },
    { path: `${dir}/ui.module.scss`, contents: uiStyle() },
    { path: `${dir}/ui/${feature.kebab}-card.tsx`, contents: cardSource(feature) },
    { path: `${dir}/ui/${feature.kebab}-form.tsx`, contents: formSource(feature) },
    ...locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogSource(feature),
      merge: 'json' as const,
    })),
    // Always an app route: a slice ships a live query, a form and actions, and `generate()`
    // refuses `--surface site` for a resource rather than emit them behind a 0kb budget.
    ...routeFiles(feature.pluralKebab, { surface: 'app', locales }),
    ...(target.admin === true ? adminFiles(rawName, slice) : []),
  ];
}
