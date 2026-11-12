// /posts/:id, rendered as a member with its read answered here: each comment carries its place in
// the thread as an ORDINAL family — "1st", "2nd", "3rd", "11th" by CLDR's rules, never a suffix
// table in this app — and in Spanish the one form that language has.

import { useT } from '@postly/i18n';
import type { ActionAnswer } from '@ultimat3/action';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import { demoActorFor } from '../../auth/demo-actor';
import * as page from './page';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const POST = '00000000-0000-4000-8000-0000000000b1';

const comment = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  postId: POST,
  authorId: '00000000-0000-4000-8000-0000000000c1',
  body: `comment body ${n}`,
  createdAt: new Date('2026-10-01T09:00:00.000Z'),
});

const POST_ROW = {
  id: POST,
  orgId: ORG,
  slug: 'a-post',
  title: 'A post',
  excerpt: 'about a post',
  body: 'the body',
  coverUrl: null,
  status: 'published' as const,
  likeCount: 0,
  publishedAt: new Date('2026-10-01T08:00:00.000Z'),
  authorId: '00000000-0000-4000-8000-0000000000c1',
  authorName: 'Ada Okonjo',
  comments: Array.from({ length: 11 }, (_, index) => comment(index + 1)),
};

/** The route with `load` answered here: a unit test has no request to forward a cookie from. */
const route = { ...page, config: { ...page.config, load: () => Promise.resolve(POST_ROW) } };

const text = async (): Promise<string> =>
  (
    await renderRoute(route, {
      url: `https://example.test/posts/${POST}`,
      actor: demoActorFor('ada'),
    })
  ).text;

unitTest('each comment is numbered by English ordinal rules', async () => {
  const rendered = await text();
  for (const label of ['1st comment', '2nd comment', '3rd comment', '4th comment', '11th comment'])
    expect(rendered).toContain(label);
});

// `renderRoute` takes no locale, so the Spanish half asks the same key the page asks, in `es`.
unitTest('a Spanish reader gets the one ordinal form Spanish has', () => {
  const label = runWithContext(ctxOf({ locale: 'es' }), () =>
    useT()('app.post.commentNumber', { ordinal: 2 }),
  );
  expect(label).toBe('2.º comentario');
});

// The body is markdown, rendered as elements from a tree: a member's `<script>`, a `javascript:`
// link and a remote image all arrive as text or a plain link, never as markup.
unitTest('a hostile body renders inert', async () => {
  const body =
    '<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![pixel](https://tracker.test/p.gif)';
  const hostile = {
    ...page,
    config: { ...page.config, load: () => Promise.resolve({ ...POST_ROW, body }) },
  };
  const html = (
    await renderRoute(hostile, {
      url: `https://example.test/posts/${POST}`,
      actor: demoActorFor('ada'),
    })
  ).html;
  expect(html).not.toContain('<script>alert(1)');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toMatch(/href="\s*javascript:/i);
  expect(html).not.toContain('<img src="https://tracker.test');
  expect(html).toContain('href="https://tracker.test/p.gif"');
});

unitTest('a draft whose body moved on shows its stale excerpt as a diff', async () => {
  const draft = {
    ...page,
    config: {
      ...page.config,
      load: () =>
        Promise.resolve({
          ...POST_ROW,
          status: 'draft' as const,
          publishedAt: null,
          excerpt: 'old words',
          body: 'new words',
        }),
    },
  };
  const html = (
    await renderRoute(draft, {
      url: `https://example.test/posts/${POST}`,
      actor: demoActorFor('ada'),
    })
  ).html;
  expect(html).toContain('<mark');
  expect(html).toContain('Removed');
  expect(html).toContain('Added');
});

// A native form on this page (publish, withdraw, comment) refused: the flash's code, read in
// `load`, is shown as the app's own sentence — and a success shows nothing.
unitTest('a refused native form shows its code as a translated sentence', async () => {
  const refused = (answer: ActionAnswer) => ({
    ...page,
    config: { ...page.config, load: () => Promise.resolve({ ...POST_ROW, answer }) },
  });
  const render = async (answer: ActionAnswer) =>
    (
      await renderRoute(refused(answer), {
        url: `https://example.test/posts/${POST}`,
        actor: demoActorFor('ada'),
      })
    ).text;
  const notFound: ActionAnswer = {
    action: 'publishPost',
    outcome: 'refusal',
    code: 'X_POST_NOT_FOUND',
    issues: [],
    truncated: false,
  };
  expect(await render(notFound)).toContain('That post no longer exists.');
  expect(await render({ ...notFound, code: 'X_SOMETHING_ELSE' })).toContain(
    'That did not go through.',
  );
  expect(await render({ action: 'createComment', outcome: 'success' })).not.toContain(
    'That did not go through.',
  );
});
