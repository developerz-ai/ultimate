// /posts/board with scripting off: the server's board IS the page — a column per status, and a
// real form per card posting `id`, `from` and the chosen `to` to `movePostStatus`. Published is
// never a target, and a published card offers no move at all.

import { derivePath } from '@ultimat3/action';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import { demoActorFor } from '../../auth/demo-actor';
import * as page from './page';

const MOVE = derivePath('movePostStatus').path;
const ORG = '00000000-0000-4000-8000-0000000000a1';
const row = (n: number, status: 'draft' | 'scheduled' | 'published') => ({
  id: `00000000-0000-4000-8000-0000000000b${n}`,
  orgId: ORG,
  title: `Post ${n}`,
  status,
});

type Rows = Parameters<typeof page.Page>[0]['data'];

/** The route with `load` answered here: a unit test has no request to forward a cookie from. */
const route = {
  ...page,
  config: {
    ...page.config,
    // The board reads three columns of a post row; the rest of the row is the read's, not this test's.
    load: () =>
      Promise.resolve([
        row(1, 'draft'),
        row(2, 'scheduled'),
        row(3, 'published'),
      ] as unknown as Rows),
  },
};

const html = async (): Promise<string> =>
  (
    await renderRoute(route, {
      url: 'https://example.test/posts/board',
      actor: demoActorFor('ada'),
    })
  ).html;

unitTest('every card carries a native form to movePostStatus with its id and status', async () => {
  const out = await html();
  const forms = out.match(new RegExp(`<form method="post" action="${MOVE}"`, 'g'));
  // Draft and Scheduled: a published card has nowhere this action can take it.
  expect(forms).toHaveLength(2);
  expect(out).toContain('name="from" value="draft"');
  expect(out).toContain('<select name="to"');
  expect(out).not.toContain('name="toIndex"');
});

unitTest('Published is never offered as a target', async () => {
  const out = await html();
  const options = [...out.matchAll(/<option value="(\w+)"/g)].map((match) => match[1]);
  expect(options).not.toContain('published');
  expect(options.filter((value) => value === 'scheduled').length).toBeGreaterThan(0);
});
