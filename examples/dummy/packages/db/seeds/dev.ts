/**
 * The dev + test fixture graph. Deterministic by construction: `id('label')` is a stable UUID v5
 * of the label, and every timestamp is a literal. Same rows, same ids, every run — which is what
 * lets a bug reproduced locally reproduce in CI.
 */

import { PLAN_CATALOG, PLAN_CODES, priceOf, slugify } from '@postly/domain';
import { defineSeed } from '@ultimat3/entity';
import { comments, likes, members, orgs, plans, posts } from '../src/index';

const ARTICLE = [
  'Postly is a team blog with an opinion: the org owns the content, the member owns the',
  'preferences. Timezone and locale live on the membership, so the same post renders at',
  '09:00 in Madrid and 09:00 in Auckland without a single conditional in a component.',
].join(' ');

export const dev = defineSeed('dev', async ({ insert, id }) => {
  // The catalog: every plan priced in every supported currency. No runtime conversion, ever.
  await insert(
    plans,
    PLAN_CODES.flatMap((code) =>
      (['USD', 'EUR'] as const).map((currency) => ({
        code,
        currency,
        monthly: priceOf(code, currency),
        seats: PLAN_CATALOG[code].seats,
      })),
    ),
  );

  // Two tenants, two currencies, two plans — enough to catch a missing orgId filter.
  await insert(orgs, [
    {
      id: id('org:acme'),
      slug: 'acme',
      name: 'Acme Editorial',
      planCode: 'team',
      billingCurrency: 'USD',
      createdAt: new Date('2026-01-05T09:00:00Z'),
      updatedAt: new Date('2026-01-05T09:00:00Z'),
    },
    {
      id: id('org:tinta'),
      slug: 'tinta',
      name: 'Tinta Studio',
      planCode: 'free',
      billingCurrency: 'EUR',
      createdAt: new Date('2026-02-11T14:30:00Z'),
      updatedAt: new Date('2026-02-11T14:30:00Z'),
    },
  ]);

  // Five members: four zones (one southern-hemisphere DST, one no-DST), both locales, both roles
  // that matter for `post:publish`, and one digest opt-out.
  await insert(members, [
    {
      id: id('member:ada'),
      orgId: id('org:acme'),
      userId: id('user:ada'),
      email: 'ada@acme.example',
      name: 'Ada Okonjo',
      role: 'owner',
      tz: 'America/New_York',
      locale: 'en',
      theme: 'dark',
      digestOptIn: true,
      createdAt: new Date('2026-01-05T09:00:00Z'),
    },
    {
      id: id('member:bruno'),
      orgId: id('org:acme'),
      userId: id('user:bruno'),
      email: 'bruno@acme.example',
      name: 'Bruno Salas',
      role: 'author',
      tz: 'Europe/Madrid',
      locale: 'es',
      digestOptIn: true,
      createdAt: new Date('2026-01-06T11:20:00Z'),
    },
    {
      id: id('member:kenji'),
      orgId: id('org:acme'),
      userId: id('user:kenji'),
      email: 'kenji@acme.example',
      name: 'Kenji Mori',
      role: 'reader',
      // Asia/Tokyo has no DST: the digest schedule must be stable across March and November.
      tz: 'Asia/Tokyo',
      locale: 'en',
      digestOptIn: false,
      createdAt: new Date('2026-01-09T02:05:00Z'),
    },
    {
      id: id('member:mara'),
      orgId: id('org:tinta'),
      userId: id('user:mara'),
      email: 'mara@tinta.example',
      name: 'Mara Ferrer',
      role: 'owner',
      // Southern hemisphere: DST runs the opposite way round from Madrid.
      tz: 'Pacific/Auckland',
      locale: 'es',
      theme: 'light',
      digestOptIn: true,
      createdAt: new Date('2026-02-11T14:30:00Z'),
    },
    {
      id: id('member:noa'),
      orgId: id('org:tinta'),
      userId: id('user:noa'),
      email: 'noa@tinta.example',
      name: 'Noa Klein',
      role: 'admin',
      tz: 'Europe/Berlin',
      locale: 'en',
      digestOptIn: true,
      createdAt: new Date('2026-02-12T08:45:00Z'),
    },
  ]);

  const published = (title: string, at: string) => ({
    slug: slugify(title),
    title,
    excerpt: `${ARTICLE.slice(0, 120)}…`,
    body: ARTICLE,
    status: 'published' as const,
    publishedAt: new Date(at),
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });

  await insert(posts, [
    {
      id: id('post:tenancy'),
      orgId: id('org:acme'),
      authorId: id('member:ada'),
      coverUrl: 'https://cdn.postly.example/covers/tenancy.jpg',
      likeCount: 2,
      ...published('Tenancy is a column, not a convention', '2026-03-02T13:00:00Z'),
    },
    {
      id: id('post:timezones'),
      orgId: id('org:acme'),
      authorId: id('member:bruno'),
      coverUrl: null,
      likeCount: 1,
      ...published('Nadie formatea una fecha sin zona', '2026-03-09T07:30:00Z'),
    },
    {
      // The draft: `publishPost` and its policy denial test both need one.
      id: id('post:draft-money'),
      orgId: id('org:acme'),
      authorId: id('member:bruno'),
      slug: 'money-is-an-integer',
      title: 'Money is an integer',
      excerpt: 'Minor units and a currency, formatted only at the edge.',
      body: ARTICLE,
      coverUrl: null,
      status: 'draft',
      likeCount: 0,
      publishedAt: null,
      createdAt: new Date('2026-03-15T16:00:00Z'),
      updatedAt: new Date('2026-03-15T16:00:00Z'),
    },
    {
      id: id('post:offline'),
      orgId: id('org:tinta'),
      authorId: id('member:mara'),
      coverUrl: null,
      likeCount: 0,
      ...published('El feed funciona sin conexión', '2026-03-20T21:15:00Z'),
    },
  ]);

  await insert(likes, [
    {
      orgId: id('org:acme'),
      postId: id('post:tenancy'),
      memberId: id('member:bruno'),
      createdAt: new Date('2026-03-02T14:00:00Z'),
    },
    {
      orgId: id('org:acme'),
      postId: id('post:tenancy'),
      memberId: id('member:kenji'),
      createdAt: new Date('2026-03-03T01:10:00Z'),
    },
    {
      orgId: id('org:acme'),
      postId: id('post:timezones'),
      memberId: id('member:ada'),
      createdAt: new Date('2026-03-09T12:00:00Z'),
    },
  ]);

  await insert(comments, [
    {
      id: id('comment:tenancy-1'),
      orgId: id('org:acme'),
      postId: id('post:tenancy'),
      authorId: id('member:kenji'),
      body: 'The composite key on likes is the part I keep forgetting to do.',
      createdAt: new Date('2026-03-03T01:12:00Z'),
    },
    {
      id: id('comment:offline-1'),
      orgId: id('org:tinta'),
      postId: id('post:offline'),
      authorId: id('member:noa'),
      body: 'Probado en el metro: los likes se encolan y se reconcilian.',
      createdAt: new Date('2026-03-21T06:40:00Z'),
    },
  ]);
});
