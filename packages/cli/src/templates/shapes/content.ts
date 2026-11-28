// `x new <name> --shape content`: a docs or marketing site built from files. Markdown under
// `apps/web/content/<locale>/` becomes one `site/` page per file per locale at
// `x build --target static`, zero JavaScript on every route, a sitemap with its hreflang cluster.
// Its pages read no table and no one writes them at `/admin`: a page is a committed file.

import { catalogJson } from '../catalog-json';
import { catalogPath } from '../locales';
import type { GeneratedFile, NameSet } from '../naming';
import { i18nIndex } from '../scaffold-i18n';
import { ADMIN_SPANISH } from './content-admin-es';
import { CONTENT_LOCALES, contentPageFiles } from './content-pages';
import { contentSiteFiles } from './content-site';
import { effectsDependency } from './landing-motion';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { claudeRows, shapeLines } from './shared-edits';

const edits = (): readonly ShapeEdit[] => [
  effectsDependency(),
  ...claudeRows({
    page: '`apps/web/site/page.test.ts`',
    island: 'none in this shape: `bunx x g island <name>` writes one with its states',
  }),
  ...shapeLines(
    'content',
    'a site built from files — each `apps/web/content/<locale>/<slug>.md` is a 0 KB page per locale (`apps/web/site/[page]/page.tsx`), read by `apps/web/shared/content.ts`, with no table behind it',
  ),
];

/**
 * The keys this shape's pages read, plus the design system's strings a page shows (the language
 * switcher's label, a code fence's controls): the framework's own catalog is English only, so a
 * Spanish page would print `⟦ui.language⟧` unless the app's catalogs carry them.
 */
const SHAPE_KEYS = {
  en: {
    'site.content.title': '{name} documentation',
    'site.content.description': 'Guides and reference, built from files and served with no script.',
    'site.content.headline': 'Every page here is a file.',
    'site.content.lede':
      'Write markdown under apps/web/content, one folder per language. The build renders each page in every language, with no JavaScript.',
    'site.content.pages': 'Pages',
    'site.content.home': 'Home',
    'site.content.back': 'All pages',
    'ui.language': 'Language',
    'ui.copy': 'Copy',
    'ui.copied': 'Copied',
    'ui.code.region': 'Code',
    'ui.code.wrap': 'Wrap lines',
  },
  es: {
    'site.content.title': 'Documentación de {name}',
    'site.content.description':
      'Guías y referencia, construidas a partir de archivos y sin scripts.',
    'site.content.headline': 'Cada página es un archivo.',
    'site.content.lede':
      'Escribe markdown en apps/web/content, una carpeta por idioma. La compilación genera cada página en cada idioma, sin JavaScript.',
    'site.content.pages': 'Páginas',
    'site.content.home': 'Inicio',
    'site.content.back': 'Todas las páginas',
    'ui.language': 'Idioma',
    'ui.copy': 'Copiar',
    'ui.copied': 'Copiado',
    'ui.code.region': 'Código',
    'ui.code.wrap': 'Ajustar líneas',
  },
} as const satisfies Record<(typeof CONTENT_LOCALES)[number], Record<string, string>>;

/** The base scaffold's keys this shape keeps, in Spanish: `es` holds every key `en` does. */
const baseSpanish = (app: NameSet): Readonly<Record<string, string>> => ({
  'admin.home.title': 'Administración',
  'admin.home.description': `Operaciones de ${app.pascal}.`,
  'app.offline.title': 'Sin conexión',
  'app.offline.description': 'Esta página se actualizará sola cuando vuelva la conexión.',
});

/**
 * The base scaffold's parity test asks every locale for EXACTLY the default's keys; with a second
 * locale that is false by one namespace — `admin.*`, which English reads from the framework's own
 * catalog and every other locale owes in the app's.
 */
const i18nIndexTest =
  (): string => `// Every locale carries every key the default one does. A key present in en and missing in es
// renders ⟦key⟧ to a reader, and nothing else in the app can notice. A locale holds more than the
// default by one namespace: \`admin.*\`, which English takes from the framework's own catalog.
import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { catalogs } from './index';

unitTest('every locale has every key of the default one', () => {
  const base = Object.keys(catalogs.catalogs[catalogs.default]);
  expect(catalogs.locales.length).toBeGreaterThan(1);
  for (const locale of catalogs.locales) {
    const keys = new Set(Object.keys(catalogs.catalogs[locale]));
    expect({ locale, missing: base.filter((key) => !keys.has(key)) }).toEqual({
      locale,
      missing: [],
    });
  }
});

unitTest('no catalog value is empty', () => {
  for (const catalog of Object.values(catalogs.catalogs)) {
    for (const value of Object.values(catalog)) expect(value.length).toBeGreaterThan(0);
  }
});
`;

const catalogs = (app: NameSet): readonly GeneratedFile[] => [
  { path: catalogPath('en'), merge: 'json', contents: catalogJson(SHAPE_KEYS.en) },
  {
    path: catalogPath('es'),
    merge: 'json',
    contents: catalogJson({ ...ADMIN_SPANISH, ...baseSpanish(app), ...SHAPE_KEYS.es }),
  },
  // The one registration module, regenerated for both locales by the generator's own template.
  { path: 'packages/i18n/src/index.ts', contents: i18nIndex(CONTENT_LOCALES) },
  { path: 'packages/i18n/src/index.test.ts', contents: i18nIndexTest() },
];

export const contentShape: ShapeOverlay = {
  example: false,
  drop: [
    'apps/web/app/dashboard/',
    'apps/web/shared/shell',
    'apps/web/shared/theme-toggle.island',
    'apps/web/shared/browser-client',
  ],
  dropKeys: ['app.dashboard', 'shell', 'site.home'],
  edits,
  files: (app): readonly GeneratedFile[] => [
    ...contentPageFiles(app),
    ...contentSiteFiles(app),
    ...catalogs(app),
  ],
};
