// `--shape dashboard`'s detail: one post by id, read through a `single` query as the request's
// actor, and the page `/posts` links each title to. Tests beside each, against the in-memory driver.

import type { GeneratedFile, NameSet } from '../naming';

const DIR = 'apps/web/app/post/queries';
const PAGE = 'apps/web/app/posts/[id]';

const postById =
  (): string => `// postById: one post of the caller's org, by id — the row a detail page reads. A page of at
// most one row: an id the org does not hold reads empty, so another org's post is "not found",
// never a refusal that confirms it exists. \`single\` makes the wire answer the row itself.

import { from, query, t } from '@ultimat3/query';
import type { Post } from '../entity';
import { canPostRead } from '../policy';
import * as repo from '../repo';

export const postById = query({
  input: t.object({ id: t.uuid }),
  policy: canPostRead,
  single: true,
  // The refusals a caller may branch on, closed: add each code this read comes to throw.
  errors: [],
  sql: ({ id }) =>
    from<Post>('posts', async () => {
      const row = await repo.byId(id);
      return row === undefined ? [] : [row];
    })
      .where({ id })
      .limit(1),
});
`;

const postByIdTest = (
  app: NameSet,
): string => `// postById, READ: one row of the caller's org, and nothing of another org's.
import { driver } from '@${app.kebab}/db';
import { ctxOf, frozenClock, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import * as repo from '../repo';
import { postById } from './post-by-id';

const orgId = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';
const target = postById.named('postById');
const read = 'post:read';
const member = testActor('member', { orgId, permissions: [read] }).actor;
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (owner: string, title: string) => {
  const draft = { orgId: owner, title, price: { minor: 0, currency: 'USD' } };
  const writer = ctxOf({ actor: testActor('writer', { orgId: owner }).actor, clock });
  return runWithContext(writer, () => repo.insert(draft));
};

afterEach(() => {
  driver.reset?.();
});

unitTest('a caller with no grant is refused before the read', async () => {
  const stranger = testActor('stranger', { orgId }).actor;
  const id = '00000000-0000-4000-8000-000000000001';
  const refused = await target.as(stranger, { id }).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

unitTest('the row by its id, and another org’s id reads empty', async () => {
  const ours = await store(orgId, 'ours');
  const theirs = await store(otherOrg, 'theirs');
  expect((await target.as(member, { id: ours.id })).map((row) => row.title)).toEqual(['ours']);
  expect(await target.as(member, { id: theirs.id })).toEqual([]);
});
`;

const page = (
  app: NameSet,
): string => `// /posts/:id: one post of the org that is looking — the row /posts links each title to. Read
// through the slice's own query as the request's actor, so the policy and the tenancy are the
// query's: another org's id is the not-found state, never its row.

import { useT } from '@${app.kebab}/i18n';
import type { AsyncState } from '@ultimat3/core';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute } from '@ultimat3/render';
import {
  DateTime,
  DescriptionList,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Section,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Shell } from '../../../shared/shell';
import type { Post } from '../../post/entity';
import { postById } from '../../post/queries/post-by-id';
import styles from './page.module.scss';

/** The read's outcome as DATA: the row, none (not this org's, or no such id), or the refusal. */
export type PageData = AsyncState<Post | undefined>;

/** A refusal or a malformed id is the page's error branch, never a 500 for the whole document. */
export async function postState(read: () => Promise<readonly Post[]>): Promise<PageData> {
  try {
    return { status: 'ready', data: (await read())[0] };
  } catch (error) {
    return { status: 'failed', error };
  }
}

export const config = defineRoute({
  // Per request, by id: no build holds an id to render it at, and \`stream\` would need a
  // \`prerender()\` list of every row. \`ssr\` with a param is reported unweighable, never a finding.
  render: 'ssr',
  hydrate: 'visible',
  offline: 'runtime',
  policy: { permission: 'post:read' satisfies KnownPermission },
  // The dashboard's own figure: this page hydrates the same one island, the shell's theme toggle,
  // and the post itself is server markup.
  budget: { js: '60kb' },
  load: ({ params }) => postState(() => postById({ id: params.id ?? '' })),
  meta: ({ t }) => ({
    title: t('app.post.detail'),
    description: t('app.posts.description'),
  }),
});

function Body(props: { readonly data: PageData }): JSX.Element {
  const t = useT();
  const state = props.data;
  if (state.status === 'failed') return <ErrorState error={state.error} />;
  const row = state.status === 'ready' ? state.data : undefined;
  if (row === undefined) return <EmptyState title={t('app.post.missing')} />;
  return (
    <Section title={row.title}>
      <DescriptionList
        items={[
          { term: t('app.post.priceLabel'), detail: <Money value={row.price} /> },
          {
            term: t('app.post.created'),
            detail: <DateTime value={row.createdAt} timeZone="UTC" dateStyle="medium" />,
          },
        ]}
      />
    </Section>
  );
}

export function Page(props: { readonly data: PageData }): JSX.Element {
  const t = useT();
  return (
    <Shell>
      <div class={styles.page}>
        <PageHeader title={t('app.post.detail')} />
        <Body data={props.data} />
        <a href="/posts">{t('app.post.back')}</a>
      </div>
    </Shell>
  );
}
`;

const pageTest = (
  app: NameSet,
): string => `// /posts/:id, rendered as a request renders it: the row, the not-found state for an id the
// org does not hold, and the refusal for a caller without the grant.
import { driver } from '@${app.kebab}/db';
import { useT } from '@${app.kebab}/i18n';
import { ctxOf, frozenClock, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, renderRoute, unitTest } from '@ultimat3/testing';
// The app's API, as boot loads it: \`defineApi\` names the query the page reads.
import '../../../api';
import * as repo from '../../post/repo';
import * as page from './page';

const orgId = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';
const read = 'post:read';
const member = testActor('member', { orgId, permissions: [read] }).actor;
const clock = frozenClock('2026-01-01T00:00:00.000Z');

const store = (owner: string, title: string) => {
  const draft = { orgId: owner, title, price: { minor: 1200, currency: 'USD' } };
  const writer = ctxOf({ actor: testActor('writer', { orgId: owner }).actor, clock });
  return runWithContext(writer, () => repo.insert(draft));
};

const at = (id: string) => ({ url: \`https://example.test/posts/\${id}\`, params: { id } });

afterEach(() => {
  driver.reset?.();
});

unitTest('the post, its price and when it was created', async () => {
  const row = await store(orgId, 'first post');
  const view = await renderRoute(page, { ...at(row.id), actor: member });
  expect(view.text).toContain('first post');
  expect(view.text).toContain('$12.00');
  expect(view.meta.title).toBe(useT()('app.post.detail'));
});

unitTest('another org’s post is not found, never its row', async () => {
  const theirs = await store(otherOrg, 'theirs');
  const view = await renderRoute(page, { ...at(theirs.id), actor: member });
  expect(view.text).not.toContain('theirs');
  expect(view.text).toContain(useT()('app.post.missing'));
});

unitTest('a caller the read refuses sees the refusal, and the page around it', async () => {
  const row = await store(orgId, 'ours');
  const stranger = testActor('stranger', { orgId }).actor;
  const view = await renderRoute(page, { ...at(row.id), actor: stranger });
  expect(view.html).toContain('X_FORBIDDEN');
  expect(view.text).toContain(useT()('app.post.back'));
});
`;

const pageStyles =
  (): string => `// Semantic tokens only — a raw hex here is refused by the boundaries step (guards/raw-colour.ts).
@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: grid;
  gap: tokens.space(4);
  padding: tokens.space(6);
  background: tokens.role('bg');
  color: tokens.role('fg');
}
`;

/** The read, the page, and a test beside each. */
export const dashboardDetailFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${DIR}/post-by-id.ts`, contents: postById() },
  { path: `${DIR}/post-by-id.test.ts`, contents: postByIdTest(app) },
  { path: `${PAGE}/page.tsx`, contents: page(app) },
  { path: `${PAGE}/page.test.ts`, contents: pageTest(app) },
  { path: `${PAGE}/page.module.scss`, contents: pageStyles() },
];
