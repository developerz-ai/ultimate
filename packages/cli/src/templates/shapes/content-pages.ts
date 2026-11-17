// The `content` shape's source: markdown files under `apps/web/content/<locale>/`, and the one
// reader every `site/` route reads them through. Files, not rows — a page is written by committing
// a file, and `x build --target static` renders each one per locale. No table, no migration.

import type { GeneratedFile, NameSet } from '../naming';

/** The second locale the shape routes beside `en`: one is a site, two prove the hreflang cluster. */
export const CONTENT_LOCALES = ['en', 'es'] as const;

const reader =
  (): string => `// The site's pages, read from \`apps/web/content/<locale>/<slug>.md\`. A file's \`#\` line is its
// title and its first paragraph its description. Build-time only: every route that calls this is
// \`render: 'static'\`, so a visitor's request never reads a file and the site needs no database.

import { assertCoded, renderFixShellArg, retryMemo } from '@ultimat3/core';
import { parseMarkdown } from '@ultimat3/ui';

/** One page in one locale. \`body\` is the markdown under the title, rendered by \`Markdown\`. */
export interface ContentPage {
  readonly locale: string;
  readonly slug: string;
  readonly title: string;
  readonly lead: string;
  readonly body: string;
}

const ROOT = new URL('../content/', import.meta.url);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TITLE = /^# +(\\S.*)$/;

type Block = ReturnType<typeof parseMarkdown>[number];
type Inline = Extract<Block, { kind: 'paragraph' }>['children'][number];

/** An inline run as the plain text a \`<meta name="description">\` carries. */
const plain = (inlines: readonly Inline[]): string =>
  inlines
    .map((inline) => {
      if (inline.kind === 'text' || inline.kind === 'code') return inline.text;
      if (inline.kind === 'image') return inline.alt;
      if (inline.kind === 'break') return ' ';
      return plain(inline.children);
    })
    .join('');

/** One file, read. Refused, naming the file, when it cannot say what it is. */
export function readPage(locale: string, slug: string, markdown: string): ContentPage {
  const file = \`apps/web/content/\${locale}/\${slug}.md\`;
  assertCoded(
    SLUG.test(slug),
    'X_INVARIANT',
    \`\${file}: a file name is the page's URL, so it is lowercase words joined by hyphens\`,
    \`mv \${renderFixShellArg(file, '<file>')} apps/web/content/\${locale}/<lowercase-slug>.md\`,
  );
  const [first = '', ...rest] = markdown.split('\\n');
  const title = TITLE.exec(first.trim())?.[1]?.trim();
  assertCoded(
    title !== undefined,
    'X_INVARIANT',
    \`\${file} does not open with a "# Title" line, so the page has no title\`,
    \`edit \${file}: make its first line "# <the page title>"\`,
  );
  const body = rest.join('\\n').trim();
  const blocks = parseMarkdown(body);
  assertCoded(
    !blocks.some((block) => block.kind === 'heading' && block.level === 1),
    'X_INVARIANT',
    \`\${file} has a second "#" heading, and a page has one h1\`,
    \`edit \${file}: turn every "#" heading after the first line into "##"\`,
  );
  const lead = blocks.find((block) => block.kind === 'paragraph');
  assertCoded(
    lead !== undefined,
    'X_INVARIANT',
    \`\${file} has no paragraph under its title, so the page has no description\`,
    \`edit \${file}: add one sentence under the title saying what the page is\`,
  );
  return { locale, slug, title, lead: plain(lead.children).trim(), body };
}

async function load(): Promise<readonly ContentPage[]> {
  const root = Bun.fileURLToPath(ROOT);
  const paths = await Array.fromAsync(new Bun.Glob('*/*.md').scan({ cwd: root }));
  return await Promise.all(
    paths.sort().map(async (path) => {
      const [locale = '', name = ''] = path.split('/');
      return readPage(
        locale,
        name.slice(0, -'.md'.length),
        await Bun.file(\`\${root}/\${path}\`).text(),
      );
    }),
  );
}

/** Every page in every locale, read on the first call and shared by every route after it. */
const corpus = retryMemo(load);

/** The pages of one locale, in file-name order. */
export async function contentPages(locale: string): Promise<readonly ContentPage[]> {
  return (await corpus.get()).filter((page) => page.locale === locale);
}

/** One page, or the 404 a static route answers for a path it never built. */
export async function contentPage(locale: string, slug: string): Promise<ContentPage> {
  const page = (await contentPages(locale)).find((candidate) => candidate.slug === slug);
  assertCoded(
    page !== undefined,
    'X_NOT_FOUND',
    \`no page apps/web/content/\${locale}/\${slug}.md\`,
    \`ls apps/web/content/\${locale}   # every page is a file here; translate the default locale's into it\`,
  );
  return page;
}
`;

const readerTest = (
  app: NameSet,
): string => `// The reader: what a file becomes, every file it refuses, and that every locale has every page —
// a page missing in one locale is a 404 in that language that nothing else would notice.
import '@${app.kebab}/i18n';
import { routedLocales } from '@ultimat3/i18n';
import { expect, unitTest } from '@ultimat3/testing';
import { contentPage, contentPages, readPage } from './content';

const coded = (code: string) => expect.objectContaining({ code });

unitTest('a file is its title, its lead as plain text, and the body under the title', () => {
  const page = readPage('en', 'hello', '# Hello\\n\\nThe **first** [line](/x), \`code\`.\\n\\n## A');
  expect(page.title).toBe('Hello');
  expect(page.lead).toBe('The first line, code.');
  expect(page.body.startsWith('The **first**')).toBe(true);
});

unitTest('a file that cannot say what it is is refused, naming the file', () => {
  expect(() => readPage('en', 'Bad Name', '# T\\n\\nLead.')).toThrow(coded('X_INVARIANT'));
  expect(() => readPage('en', 'untitled', 'Lead only.')).toThrow(coded('X_INVARIANT'));
  expect(() => readPage('en', 'twice', '# One\\n\\nLead.\\n\\n# Two')).toThrow(coded('X_INVARIANT'));
  expect(() => readPage('en', 'bare', '# Title\\n\\n## Only a heading')).toThrow(
    coded('X_INVARIANT'),
  );
});

unitTest('every routed locale has the same pages as the default one', async () => {
  const [fallback = 'en', ...others] = routedLocales();
  const slugs = async (locale: string) => (await contentPages(locale)).map((page) => page.slug);
  const expected = await slugs(fallback);
  expect(expected.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  for (const locale of others)
    expect({ locale, slugs: await slugs(locale) }).toEqual({ locale, slugs: expected });
});

unitTest('one page by locale and slug, and X_NOT_FOUND for a path no file builds', async () => {
  const [first] = await contentPages('en');
  expect((await contentPage('en', first?.slug ?? '')).title).toBe(first?.title ?? '');
  await expect(contentPage('en', 'no-such-page')).rejects.toThrow(coded('X_NOT_FOUND'));
});
`;

const GETTING_STARTED_EN = `# Getting started

Every page on this site is a markdown file, rendered once per language when the site is built.

## Write a page

1. Add a file under \`apps/web/content/en/\`. Its name is the page's address, its first line is the
   title, and its first paragraph is the description a search result shows.
2. Add the same file, translated, under every other locale folder.
3. Run \`bun run verify\`. The build renders the page in every language, and refuses one that is
   missing in any of them.

## What ships

No JavaScript, on any page. The sitemap lists each page once per language, and every copy links
to the others.
`;

const GETTING_STARTED_ES = `# Primeros pasos

Cada página de este sitio es un archivo markdown, generado una vez por idioma al construir el sitio.

## Escribir una página

1. Añade un archivo en \`apps/web/content/en/\`. Su nombre es la dirección de la página, su primera
   línea es el título y su primer párrafo es la descripción que muestra un buscador.
2. Añade el mismo archivo, traducido, en la carpeta de cada otro idioma.
3. Ejecuta \`bun run verify\`. La compilación genera la página en cada idioma y rechaza la que
   falte en alguno.

## Qué se publica

Nada de JavaScript, en ninguna página. El mapa del sitio lista cada página una vez por idioma, y
cada copia enlaza a las demás.
`;

const ABOUT_EN = `# About

What this site is, and who keeps it. Replace this file with your own words.

It is built from files with no database behind it, so any static host can serve it.
`;

const ABOUT_ES = `# Acerca de

Qué es este sitio y quién lo mantiene. Sustituye este archivo por tus propias palabras.

Se construye a partir de archivos sin base de datos detrás, así que cualquier alojamiento estático
puede servirlo.
`;

/** The reader, its test, and two pages in each locale. */
export function contentPageFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/shared/content.ts', contents: reader() },
    { path: 'apps/web/shared/content.test.ts', contents: readerTest(app) },
    { path: 'apps/web/content/en/getting-started.md', contents: GETTING_STARTED_EN },
    { path: 'apps/web/content/en/about.md', contents: ABOUT_EN },
    { path: 'apps/web/content/es/getting-started.md', contents: GETTING_STARTED_ES },
    { path: 'apps/web/content/es/about.md', contents: ABOUT_ES },
  ];
}
