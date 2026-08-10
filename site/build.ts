#!/usr/bin/env bun
// Renders site/pages/*.md through site/templates/*.html into site/dist/, then emits
// sitemap.xml, robots.txt, feed.xml, llms.txt and the CSP hash for the inline theme
// script. Zero dependencies: markdown, highlighting and SCSS assembly are all local,
// because a marketing site that claims "no dependency runtime" has to mean it.

import { mkdirSync, rmSync } from 'node:fs';
import { compileScript, compileStyles, copyDir, readText } from './lib/assets';
import type { Page } from './lib/config';
import { DIST, FRAMEWORK_VERSION, ORIGIN, PAGE_ORDER, REPO_ROOT, ROOT } from './lib/config';
import { feedXml } from './lib/feed';
import { renderCode } from './lib/highlight';
import { jsonLd, navHtml, pagerHtml, tocHtml } from './lib/html';
import { inline, markdown } from './lib/markdown';
import { seoCheck } from './lib/seo';
import { escapeHtml, fill, frontmatter } from './lib/text';

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

    // `version` reaches every fill map, not just JSON-LD: the release number is one fact, and a
    // template that hardcodes it is the drift the manifest read exists to remove.
    const body = isHome
      ? fill(homeTemplate, {
          headline: escapeHtml(page.meta.headline ?? page.meta.title ?? ''),
          lede: inline(page.meta.lede ?? page.meta.description ?? ''),
          hero_code: heroCode,
          content: rendered.html,
          version: FRAMEWORK_VERSION,
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
          version: FRAMEWORK_VERSION,
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
      version: FRAMEWORK_VERSION,
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
