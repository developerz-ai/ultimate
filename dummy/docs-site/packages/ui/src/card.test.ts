// The card, rendered the way a page renders it. What a typecheck cannot see is where a prop
// lands: the title is the card's heading, and the children follow it inside the same section.
import { expect, renderView, unitTest } from '@ultimat3/testing';
import { Card } from './card';

unitTest('the card puts its title in a heading and its children after it', async () => {
  const view = await renderView(Card, { title: 'Usage', children: 'body copy' });
  expect(view.html).toMatch(/^<section[^>]*><h2[^>]*>Usage<\/h2>body copy<\/section>$/);
});

unitTest('a card with no children is its heading and nothing else', async () => {
  const view = await renderView(Card, { title: 'Empty' });
  expect(view.text).toBe('Empty');
});
