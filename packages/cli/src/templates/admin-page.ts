// `x g admin:page <name>` — a screen the admin derives from nothing: a reconciliation fixer, a
// proxy health board, a deploy button. What the template has to get right is what it does NOT
// emit: no `defineRoute`, because `pages:` is the one thing that puts a page in the admin's route
// table and `guardedPage()` is the one thing that decides it. A scaffold that wrote a route
// declaration here would hand back the unguarded second way in that seam exists to close.

import { catalogJson } from './catalog-json';
import { sortedImports } from './imports';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile } from './naming';
import { camel, kebab, pascal } from './naming';

/** Where an admin lives when the caller does not say. `x new` scaffolds this layout. */
export const DEFAULT_ADMIN_PAGE_DIR = 'apps/admin/src/pages';

export interface AdminPageOptions {
  /** The permission the page's own work needs. `admin:read` is composed in front of it. */
  readonly permission: string;
  /**
   * Directory the page lands in, app-root-relative and POSIX — the same `--at` `x g island` takes,
   * and for the same reason: an app's admin is wherever its `defineAdmin` is, which no generator
   * can derive. `apps/admin/app/admin/` is as real a layout as the scaffold's, and a hardcoded
   * destination means every such app moves the two files by hand after every run.
   */
  readonly dir?: string;
  readonly locales?: readonly string[];
  /**
   * The app's own catalog module — `@<app>/i18n`, read off `packages/i18n/package.json` by
   * `resolveCatalogModule`. Absent only for an app that ships no such package.
   */
  readonly catalogModule?: string;
}

const titleKeyFor = (name: string): string => `admin.${name}.title`;

/**
 * The generated page reaches strings through the APP's catalog module — the one that calls
 * `defineCatalogs()` — so a page that renders a string depends on the module that registers them.
 * `t` from `@ultimat3/i18n` renders while depending on nothing, which is how a shipped app served
 * every string as a loud miss with a green gate (issue #249). An app with no catalog module keeps
 * the framework import: emitting one that cannot resolve is worse than the wrong idiom.
 */
const catalogImport = (module: string | undefined): string =>
  module === undefined
    ? "import { t } from '@ultimat3/i18n';"
    : `import { useT } from '${module}';`;

/**
 * The two imports, in the order biome's organize-imports wants — which DEPENDS on the app's scope
 * and cannot be hardcoded either way. An app catalog (`@myapp/i18n`) sorts BEFORE
 * `@ultimat3/admin`; the fallback `@ultimat3/i18n` sorts AFTER it, and `@zebra/i18n` after that.
 * Emitting one fixed order makes every generated admin page a lint error in one of those cases.
 *
 * `sortedImports` is this sort, moved to `templates/imports.ts` so the four scaffold sites that
 * had the same mix and none of the fix share it — `x new zebra` was four `organizeImports` errors
 * on its first `x verify`.
 */
const pageImports = (module: string | undefined): string =>
  sortedImports([
    `import type { AdminCustomPage, AdminPageProps } from '@ultimat3/admin';`,
    catalogImport(module),
  ]);

/** `useT()` is per render, so the component binds it in its own body. */
const translatorBinding = (module: string | undefined): string =>
  module === undefined ? '' : '\n  const t = useT();\n';

const pageSource = (
  name: string,
  permission: string,
  dir: string,
  module: string | undefined,
): string => {
  const Name = pascal(name);
  const declaration = camel(name);
  return `// Admin page: /${name}. An ORDINARY component — there is no \`defineRoute\` here, deliberately:
// \`pages:\` is what puts this in the admin's route table and \`guardedPage()\` is what decides it,
// so a route declaration in this file would be a second, unguarded way in.
//
// Wire it in once, and add \`navGroup\` to link it in the sidebar — this file is ${dir}/${name}.tsx,
// so the specifier is relative to wherever \`defineAdmin\` lives:
//   import { ${declaration}Page } from './${name}';
//   defineAdmin({ …, pages: […, ${declaration}Page] })

${pageImports(module)}

export function ${Name}Page(props: AdminPageProps) {${translatorBinding(module)}
  return (
    <section>
      <h1>{t('${titleKeyFor(name)}')}</h1>
      <p>{props.url}</p>
    </section>
  );
}

export const ${declaration}Page: AdminCustomPage = {
  path: '/${name}',
  titleKey: '${titleKeyFor(name)}',
  // At least one, never empty: an empty list is X_ADMIN_PAGE_UNGUARDED at declaration time, which
  // is the whole reason the permission is a required field and not an optional one.
  permissions: ['${permission}'],
  component: ${Name}Page,
};
`;
};

const pageTest = (name: string, permission: string): string => {
  const declaration = camel(name);
  return `// The ${name} admin page is guarded and owns no route of its own — the two facts that separate an
// admin screen from a page, and the two an edit here is most likely to break.
import { expect, unitTest } from '@ultimat3/testing';
import { ${declaration}Page } from './${name}';

// Both facts the frame reads off the declaration, so both are decidable without a request: a path
// that is not rooted is X_ADMIN_PAGE_PATH_INVALID, and no permission at all is
// X_ADMIN_PAGE_UNGUARDED — a page that would render for anyone who can open the admin.
unitTest('the ${name} admin page is rooted and guarded', () => {
  expect(${declaration}Page.path.startsWith('/')).toBe(true);
  expect(${declaration}Page.permissions).toContain('${permission}');
});

unitTest('the ${name} admin page declares no route of its own', () => {
  // \`pages:\` is the only way in. A \`config\` export here would be a route the frame never guards.
  expect('config' in ${declaration}Page).toBe(false);
});
`;
};

export function adminPageFiles(
  rawName: string,
  options: AdminPageOptions,
): readonly GeneratedFile[] {
  const name = kebab(rawName);
  // Trailing slashes trimmed exactly as `islandFiles` does — one `--at`, one normalization.
  const dir = (options.dir ?? DEFAULT_ADMIN_PAGE_DIR).replace(/\/+$/, '');
  return [
    {
      path: `${dir}/${name}.tsx`,
      contents: pageSource(name, options.permission, dir, options.catalogModule),
    },
    { path: `${dir}/${name}.test.ts`, contents: pageTest(name, options.permission) },
    ...resolveLocales(options.locales).map((locale) => ({
      path: catalogPath(locale),
      contents: catalogJson({ [titleKeyFor(name)]: pascal(name) }),
      merge: 'json' as const,
    })),
  ];
}
