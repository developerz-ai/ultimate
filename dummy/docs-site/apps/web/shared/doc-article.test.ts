// A wiki piece as a page: one h1 from its title, the body rendered, and the two ways out.
import { expect, renderView, unitTest } from '@ultimat3/testing';
import { DocArticle } from './doc-article';

const piece = {
  url: '/money',
  file: 'Money.md',
  title: 'Money',
  lead: 'Integers.',
  markdown: 'Integers, **never** a float.\n\n## Why\n\nBecause.',
  headings: [{ level: 2, text: 'Why', anchor: 'why' }],
};

unitTest('the title is the one h1; the body is rendered markdown, not its source', async () => {
  const view = await renderView(DocArticle, { piece, nav: 'manual' });
  expect(view.html.match(/<h1\b/g)).toHaveLength(1);
  expect(view.html).toContain('<strong>never</strong>');
  expect(view.text).not.toContain('**');
});

unitTest('it links to its wiki file and to its markdown sibling', async () => {
  const view = await renderView(DocArticle, { piece, nav: 'manual' });
  expect(view.html).toContain(
    'href="https://github.com/developerz-ai/ultimate/blob/main/wiki/Money.md"',
  );
  expect(view.html).toContain('href="/money.md"');
});
