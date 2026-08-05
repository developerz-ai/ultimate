// The SEO gate over the parsed pages: a title and a sized description on every page, and no two
// pages sharing either. It throws before anything renders, so a bad page fails the build.

import type { Page } from './config';

export function seoCheck(pages: readonly Page[]): void {
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
