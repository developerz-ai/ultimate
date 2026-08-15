// `x g admin:page <name>` — a screen the admin derives from nothing: a reconciliation fixer, a
// proxy health board, a deploy button. What the template has to get right is what it does NOT
// emit: no `defineRoute`, because `pages:` is the one thing that puts a page in the admin's route
// table and `guardedPage()` is the one thing that decides it. A scaffold that wrote a route
// declaration here would hand back the unguarded second way in that seam exists to close.

import { catalogJson } from './catalog-json';
import { catalogPath, resolveLocales } from './locales';
import type { GeneratedFile } from './naming';
import { camel, kebab, pascal } from './naming';

export interface AdminPageOptions {
  /** The permission the page's own work needs. `admin:read` is composed in front of it. */
  readonly permission: string;
  readonly locales?: readonly string[];
}

const titleKeyFor = (name: string): string => `admin.${name}.title`;

const pageSource = (name: string, permission: string): string => {
  const Name = pascal(name);
  const declaration = camel(name);
  return `// Admin page: /${name}. An ORDINARY component — there is no \`defineRoute\` here, deliberately:
// \`pages:\` is what puts this in the admin's route table and \`guardedPage()\` is what decides it,
// so a route declaration in this file would be a second, unguarded way in.
//
// Wire it in once, and add \`navGroup\` to link it in the sidebar:
//   import { ${declaration}Page } from './pages/${name}';
//   defineAdmin({ …, pages: […, ${declaration}Page] })

import type { AdminCustomPage, AdminPageProps } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';

export function ${Name}Page(props: AdminPageProps) {
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
  return `import { expect, unitTest } from '@ultimat3/testing';
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
  const dir = 'apps/admin/src/pages';
  return [
    { path: `${dir}/${name}.tsx`, contents: pageSource(name, options.permission) },
    { path: `${dir}/${name}.test.ts`, contents: pageTest(name, options.permission) },
    ...resolveLocales(options.locales).map((locale) => ({
      path: catalogPath(locale),
      contents: catalogJson({ [titleKeyFor(name)]: pascal(name) }),
      merge: 'json' as const,
    })),
  ];
}
