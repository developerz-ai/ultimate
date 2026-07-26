#!/usr/bin/env bun
// Renders site/pages/*.md through site/templates/*.html into site/dist/, then emits
// sitemap.xml, robots.txt, feed.xml, llms.txt and the CSP hash for the inline theme
// script. Zero dependencies: markdown, highlighting and SCSS assembly are all local,
// because a marketing site that claims "no dependency runtime" has to mean it.

import { mkdirSync, rmSync } from 'node:fs';

const ORIGIN = 'https://ultimate.developerz.ai';
const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO_ROOT = ROOT.replace(/\/site$/, '');
const DIST = `${ROOT}/dist`;
const STYLE_ORDER = ['tokens', 'base', 'layout', 'components', 'syntax'] as const;
const PAGE_ORDER = [
  'index',
  'quickstart',
  'primitives',
  'realtime',
  'jobs',
  'rendering-seo',
  'pwa-offline',
  'ai-first',
  'deploy',
  'roadmap',
  'faq',
  'changelog',
] as const;

interface Page {
  readonly slug: string;
  readonly url: string;
  readonly file: string;
  readonly meta: Record<string, string>;
  readonly body: string;
}

// ─────────────────────────────────────────────────────────────── text helpers

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');

function frontmatter(src: string): { meta: Record<string, string>; body: string } {
  if (!src.startsWith('---\n')) return { meta: {}, body: src };
  const end = src.indexOf('\n---', 4);
  const meta: Record<string, string> = {};
  for (const line of src.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    meta[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: src.slice(end + 4).replace(/^\n+/, '') };
}

// ──────────────────────────────────────────────────────── syntax highlighting

const KEYWORDS =
  'as|async|await|break|case|catch|class|const|continue|declare|default|delete|do|else|' +
  'enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|' +
  'instanceof|interface|let|new|null|of|readonly|return|satisfies|set|static|super|' +
  'switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield';

const CODE_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*)', // 1 comment
    '(\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"|`(?:\\\\.|[^`\\\\])*`)', // 2 string
    '\\b(\\d[\\d_.]*[a-z]{0,2})\\b', // 3 number
    `\\b(${KEYWORDS})\\b`, // 4 keyword
    '\\b([A-Z][A-Za-z0-9_]*)\\b', // 5 type
    '\\b([a-zA-Z_$][\\w$]*)(?=\\s*\\()', // 6 call
  ].join('|'),
  'g',
);

const CLASSES = ['tok-comment', 'tok-string', 'tok-number', 'tok-keyword', 'tok-type', 'tok-fn'];

/** Token classes only — no AST, no grammar file. Good enough for the shapes we ship. */
function highlightCode(source: string): string {
  let out = '';
  let last = 0;
  for (const match of source.matchAll(CODE_RE)) {
    const at = match.index ?? 0;
    out += escapeHtml(source.slice(last, at));
    const group = CLASSES.findIndex((_, i) => match[i + 1] !== undefined);
    out += `<span class="${CLASSES[group]}">${escapeHtml(match[0])}</span>`;
    last = at + match[0].length;
  }
  return out + escapeHtml(source.slice(last));
}

/** Terminal transcripts: prompt, command, pass/fail marks, and the 3-line error shape. */
function highlightShell(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const prompt = /^(\s*)\$ (.*)$/.exec(line);
      if (prompt !== null) {
        return `${prompt[1]}<span class="tok-prompt">$ </span><span class="tok-cmd">${escapeHtml(prompt[2] ?? '')}</span>`;
      }
      const mark = /^(\s*)([✓✗])(.*)$/.exec(line);
      if (mark !== null) {
        const cls = mark[2] === '✓' ? 'tok-pass' : 'tok-fail';
        return `${mark[1]}<span class="${cls}">${mark[2]}</span>${escapeHtml(mark[3] ?? '')}`;
      }
      const code = /^(\s*)(X_[A-Z0-9_]+)(:.*)$/.exec(line);
      if (code !== null) {
        return `${code[1]}<span class="tok-code">${code[2]}</span>${escapeHtml(code[3] ?? '')}`;
      }
      const label = /^(\s+)(cause|fix|docs):(\s*)(.*)$/.exec(line);
      if (label !== null) {
        return `${label[1]}<span class="tok-label">${label[2]}:</span>${label[3]}${escapeHtml(label[4] ?? '')}`;
      }
      const diff = /^([+-])(.*)$/.exec(line);
      if (diff !== null) {
        const cls = diff[1] === '+' ? 'tok-added' : 'tok-removed';
        return `<span class="${cls}">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line);
    })
    .join('\n');
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console', 'text', 'diff', 'yaml', '']);

function renderCode(lang: string, title: string | undefined, source: string): string {
  const body = SHELL_LANGS.has(lang) ? highlightShell(source) : highlightCode(source);
  const cls = SHELL_LANGS.has(lang) && lang !== 'yaml' ? ' class="terminal"' : '';
  const pre = `<pre${cls} tabindex="0"><code${lang === '' ? '' : ` class="language-${lang}"`}>${body}</code></pre>`;
  if (title === undefined) return pre;
  return `<figure class="code-figure"><figcaption><span>${escapeHtml(title)}</span><span>${escapeHtml(lang)}</span></figcaption>${pre}</figure>`;
}

// ─────────────────────────────────────────────────────────────────── markdown

function inline(src: string): string {
  return src
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    })
    .join('');
}

const cells = (row: string): string[] =>
  row
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

interface Rendered {
  readonly html: string;
  readonly headings: readonly { id: string; text: string }[];
}

/** Block-level markdown: headings, lists, tables, fences, callouts, raw HTML. */
function markdown(src: string): Rendered {
  const lines = src.split('\n');
  const headings: { id: string; text: string }[] = [];
  const out: string[] = [];
  let i = 0;

  const paragraph = (buffer: string[]): void => {
    if (buffer.length > 0) out.push(`<p>${inline(buffer.join(' '))}</p>`);
    buffer.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // fenced code
    const fence = /^```(\S*)(?:\s+title="([^"]*)")?\s*$/.exec(line);
    if (fence !== null) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(renderCode(fence[1] ?? '', fence[2], buffer.join('\n')));
      continue;
    }

    // ::: callout … :::
    const callout = /^:::\s*(ok|warn|info)(?:\s+(.*))?$/.exec(line);
    if (callout !== null) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] ?? '').trim() !== ':::') {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      const label = callout[2] ?? callout[1] ?? 'note';
      const inner = markdown(buffer.join('\n')).html;
      out.push(
        `<aside class="callout callout--${callout[1]}"><span class="callout__label">${escapeHtml(label)}</span>${inner}</aside>`,
      );
      continue;
    }

    // raw HTML block — passed through untouched, so the pitch can use the grid components
    if (line.startsWith('<')) {
      const buffer: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        buffer.push(lines[i] ?? '');
        i += 1;
      }
      out.push(buffer.join('\n'));
      continue;
    }

    // heading
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '##').length;
      const text = heading[2] ?? '';
      const id = slugify(text);
      if (level === 2) headings.push({ id, text });
      out.push(
        `<h${level} id="${id}">${inline(text)}` +
          `<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
      );
      i += 1;
      continue;
    }

    // table
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      const thead = head.map((c) => `<th scope="col">${inline(c)}</th>`).join('');
      const tbody = rows
        .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<div class="table-scroll" tabindex="0"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    // lists
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null || ordered !== null) {
      const tag = bullet !== null ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(current);
        if (item !== null) {
          items.push(item[1] ?? '');
        } else if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] += ` ${current.trim()}`;
        } else {
          break;
        }
        i += 1;
      }
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // blockquote
    if (line.startsWith('> ')) {
      const buffer: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        buffer.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdown(buffer.join('\n')).html}</blockquote>`);
      continue;
    }

    if (/^(---|\*\*\*)\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // paragraph
    const buffer: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        current.startsWith('#') ||
        current.startsWith('|') ||
        current.startsWith('```') ||
        current.startsWith(':::') ||
        current.startsWith('<') ||
        current.startsWith('> ') ||
        /^(?:[-*]|\d+\.)\s/.test(current)
      ) {
        break;
      }
      buffer.push(current.trim());
      i += 1;
    }
    paragraph(buffer);
  }

  return { html: out.join('\n'), headings };
}

// ────────────────────────────────────────────────────────────────── assembly

async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/** SCSS here is nesting + custom properties only, so stripping `//` comments is a compile. */
async function compileStyles(): Promise<string> {
  const parts: string[] = [];
  for (const name of STYLE_ORDER) {
    const src = await readText(`${ROOT}/styles/${name}.scss`);
    parts.push(
      src
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n'),
    );
  }
  return parts
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([{;:,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

async function compileScript(): Promise<string> {
  const src = await readText(`${ROOT}/scripts/theme.js`);
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function seoCheck(pages: readonly Page[]): void {
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const page of pages) {
    const title = page.meta.title ?? '';
    const description = page.meta.description ?? '';
    if (title === '') throw new Error(`X_SEO_NO_TITLE: ${page.file} has no title in frontmatter`);
    if (description === '') {
      throw new Error(`X_SEO_NO_DESCRIPTION: ${page.file} has no description in frontmatter`);
    }
    if (description.length < 50 || description.length > 160) {
      throw new Error(
        `X_SEO_NO_DESCRIPTION: ${page.file} description is ${description.length} chars, needs 50-160`,
      );
    }
    const dupeTitle = titles.get(title);
    if (dupeTitle !== undefined) {
      throw new Error(`X_SEO_DUPLICATE_TITLE: ${page.file} repeats the title of ${dupeTitle}`);
    }
    const dupeDescription = descriptions.get(description);
    if (dupeDescription !== undefined) {
      throw new Error(
        `X_SEO_DUPLICATE_DESCRIPTION: ${page.file} repeats the description of ${dupeDescription}`,
      );
    }
    titles.set(title, page.file);
    descriptions.set(description, page.file);
  }
}

function navHtml(pages: readonly Page[], current: Page): string {
  return (
    pages
      // `menu: true` opts a page into the header; every page is still reachable from the
      // footer and the pager, so the header never has to grow a scroll region on desktop.
      .filter((page) => page.meta.menu === 'true')
      .map((page) => {
        const active = page.slug === current.slug ? ' aria-current="page"' : '';
        return `              <li><a href="${page.url}"${active}>${escapeHtml(page.meta.nav ?? '')}</a></li>`;
      })
      .join('\n')
  );
}

function tocHtml(headings: readonly { id: string; text: string }[]): string {
  if (headings.length === 0) return '';
  const items = headings
    .map((h) => `      <li><a href="#${h.id}">${inline(h.text)}</a></li>`)
    .join('\n');
  return `    <ol>\n${items}\n    </ol>`;
}

function pagerHtml(pages: readonly Page[], index: number): string {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (previous === undefined && next === undefined) return '';
  const left =
    previous === undefined
      ? '<span></span>'
      : `<a href="${previous.url}"><span>Previous</span><strong>${escapeHtml(previous.meta.nav ?? previous.slug)}</strong></a>`;
  const right =
    next === undefined
      ? '<span></span>'
      : `<a class="pager--next" href="${next.url}"><span>Next</span><strong>${escapeHtml(next.meta.nav ?? next.slug)}</strong></a>`;
  return `    <nav class="pager" aria-label="Page navigation">${left}${right}</nav>`;
}

function jsonLd(page: Page, isHome: boolean): string {
  const graph = isHome
    ? {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Ultimate',
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Web framework',
        operatingSystem: 'Linux, macOS',
        description: page.meta.description,
        url: `${ORIGIN}/`,
        softwareVersion: '0.0.1',
        license: 'https://opensource.org/licenses/MIT',
        codeRepository: 'https://github.com/developerz-ai/ultimate',
        runtimePlatform: 'Bun >= 1.3',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        author: { '@type': 'Organization', name: 'developerz-ai' },
      }
    : {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: page.meta.title,
        description: page.meta.description,
        url: `${ORIGIN}${page.url}`,
        dateModified: page.meta.updated,
        inLanguage: 'en',
        isPartOf: { '@type': 'WebSite', name: 'Ultimate', url: `${ORIGIN}/` },
        author: { '@type': 'Organization', name: 'developerz-ai' },
        proficiencyLevel: 'Expert',
      };
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Ultimate', item: `${ORIGIN}/` },
      ...(isHome
        ? []
        : [
            {
              '@type': 'ListItem',
              position: 2,
              name: page.meta.title,
              item: `${ORIGIN}${page.url}`,
            },
          ]),
    ],
  };
  return [graph, crumbs]
    .map(
      (data) =>
        // `<` is escaped so no value can close the script element early.
        `    <script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`,
    )
    .join('\n');
}

function feedXml(changelog: Page): string {
  // Sections are split by hand rather than by one regex: `$` under /m would end the
  // capture at the first line break and every description would ship empty.
  const items = changelog.body
    .split(/^## /m)
    .map((section) => /^(.+?) — (\d{4}-\d{2}-\d{2})\n([\s\S]*)$/.exec(section))
    .filter((match): match is RegExpExecArray => match !== null)
    .slice(0, 20)
    .map((match) => {
      const [, version = '', date = '', body = ''] = match;
      const id = slugify(`${version} ${date}`);
      const summary = body
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).replace(/[`*[\]]/g, ''))
        .join(' · ');
      return `    <item>
      <title>${escapeHtml(version)}</title>
      <link>${ORIGIN}/changelog/#${id}</link>
      <guid isPermaLink="false">ultimate-${id}</guid>
      <pubDate>${new Date(`${date}T00:00:00Z`).toUTCString()}</pubDate>
      <description>${escapeHtml(summary)}</description>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ultimate changelog</title>
    <link>${ORIGIN}/changelog/</link>
    <atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Releases and milestone notes for the Ultimate framework.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

async function copyDir(from: string, to: string): Promise<number> {
  let count = 0;
  for await (const entry of new Bun.Glob('**/*').scan({ cwd: from, onlyFiles: true })) {
    await Bun.write(`${to}/${entry}`, Bun.file(`${from}/${entry}`));
    count += 1;
  }
  return count;
}

// ────────────────────────────────────────────────────────────────────── build

async function build(): Promise<void> {
  const started = Bun.nanoseconds();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const layout = await readText(`${ROOT}/templates/layout.html`);
  const homeTemplate = await readText(`${ROOT}/templates/home.html`);
  const docTemplate = await readText(`${ROOT}/templates/doc.html`);
  const css = await compileStyles();
  const js = await compileScript();

  const pages: Page[] = [];
  for (const name of PAGE_ORDER) {
    const file = `pages/${name}.md`;
    const parsed = frontmatter(await readText(`${ROOT}/${file}`));
    pages.push({
      slug: name,
      url: name === 'index' ? '/' : `/${name}/`,
      file,
      meta: parsed.meta,
      body: parsed.body,
    });
  }
  seoCheck(pages);

  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(css + js + pages.map((p) => p.body).join(''));
  const buildId = hasher.digest('hex').slice(0, 7);
  const scriptHash = new Bun.CryptoHasher('sha256').update(js).digest('base64');
  const styleHash = new Bun.CryptoHasher('sha256').update(css).digest('base64');
  const built = new Date().toISOString().slice(0, 10);

  for (const [index, page] of pages.entries()) {
    const isHome = page.slug === 'index';
    let source = page.body;
    let heroCode = '';
    if (isHome) {
      // The hero shows the first fenced block of the pitch, then drops it from the flow.
      const fence = /```(\S*)\n([\s\S]*?)```\n?/.exec(source);
      if (fence !== null) {
        heroCode = renderCode(fence[1] ?? '', undefined, (fence[2] ?? '').replace(/\n$/, ''));
        source = source.replace(fence[0], '');
      }
    }
    const rendered = markdown(source);

    const body = isHome
      ? fill(homeTemplate, {
          headline: escapeHtml(page.meta.headline ?? page.meta.title ?? ''),
          lede: inline(page.meta.lede ?? page.meta.description ?? ''),
          hero_code: heroCode,
          content: rendered.html,
        })
      : fill(docTemplate, {
          breadcrumb:
            '    <nav class="breadcrumb" aria-label="Breadcrumb"><ol>' +
            `<li><a href="/">Ultimate</a></li><li aria-current="page">${escapeHtml(page.meta.nav ?? '')}</li>` +
            '</ol></nav>',
          h1: escapeHtml(page.meta.title ?? ''),
          lede: inline(page.meta.lede ?? page.meta.description ?? ''),
          content: rendered.html,
          toc: tocHtml(rendered.headings),
          pager: pagerHtml(pages, index),
        });

    const previous = pages[index - 1];
    const next = pages[index + 1];
    const headExtra = [
      jsonLd(page, isHome),
      previous === undefined ? '' : `    <link rel="prev" href="${ORIGIN}${previous.url}" />`,
      next === undefined ? '' : `    <link rel="next" href="${ORIGIN}${next.url}" />`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    // Escaped here, not at the source: these land inside HTML attributes, and a
    // description containing a quote would otherwise close the attribute early.
    const html = fill(layout, {
      title: escapeHtml(
        isHome
          ? `${page.meta.title} — an agent-first Bun framework`
          : `${page.meta.title} · Ultimate`,
      ),
      og_title: escapeHtml(page.meta.title ?? 'Ultimate'),
      description: escapeHtml(page.meta.description ?? ''),
      canonical: `${ORIGIN}${page.url}`,
      og_type: isHome ? 'website' : 'article',
      og_image: `${ORIGIN}/assets/og.svg`,
      head_extra: headExtra,
      inline_css: css,
      inline_js: js,
      nav: navHtml(pages, page),
      body,
      built,
      build_id: `build ${buildId}`,
    });

    await Bun.write(isHome ? `${DIST}/index.html` : `${DIST}/${page.slug}/index.html`, html);
  }

  const sitemap = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.w3.org/1999/xhtml/sitemap/0.9" xmlns:x="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (page) => `  <url>
    <loc>${ORIGIN}${page.url}</loc>
    <lastmod>${page.meta.updated ?? built}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${page.slug === 'index' ? '1.0' : '0.7'}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`.replace('xmlns="http://www.w3.org/1999/xhtml/sitemap/0.9" xmlns:x=', 'xmlns=');

  const changelog = pages.find((page) => page.slug === 'changelog');
  await Bun.write(`${DIST}/sitemap.xml`, sitemap);
  await Bun.write(
    `${DIST}/robots.txt`,
    `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
  );
  if (changelog !== undefined) await Bun.write(`${DIST}/feed.xml`, feedXml(changelog));
  await Bun.write(`${DIST}/CNAME`, await readText(`${ROOT}/CNAME`));
  await Bun.write(`${DIST}/.nojekyll`, '');
  await Bun.write(`${DIST}/llms.txt`, await readText(`${REPO_ROOT}/llms.txt`));
  await Bun.write(
    `${DIST}/csp.txt`,
    `default-src 'none'; img-src 'self' data:; style-src 'sha256-${styleHash}'; ` +
      `script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'\n`,
  );
  const assets = await copyDir(`${ROOT}/assets`, `${DIST}/assets`);

  const ms = ((Bun.nanoseconds() - started) / 1e6).toFixed(0);
  console.log(`  ✓ pages      ${pages.length} rendered, 0kb js baseline`);
  console.log(`  ✓ styles     ${(css.length / 1024).toFixed(1)}kb inlined, no webfont`);
  console.log(`  ✓ script     ${js.length}b inline theme toggle (sha256 in dist/csp.txt)`);
  console.log(`  ✓ assets     ${assets} copied, sitemap + robots + feed emitted`);
  console.log(`  ✓ build      ${buildId} in ${ms}ms  ->  site/dist`);
}

await build();
