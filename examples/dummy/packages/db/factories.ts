// Postly's factories: one per entity a test makes rows of, and `factories`, the set `x verify`'s
// unit step lints (`packages/db/factories.ts` is the one place a gate looks). Test-only: no app
// module imports this file, so `@ultimat3/testing` never reaches a bundle.
import { belongsTo, defineFactory, hasMany } from '@ultimat3/testing';
import { comments, members, orgs, posts } from './src';

export const orgFactory = defineFactory(orgs, {
  defaults: (n, ids) => ({ id: ids.uuid(), slug: `org-${n}`, name: `Org ${n}` }),
});
export const memberFactory = defineFactory(members, {
  defaults: (n, ids) => ({
    id: ids.uuid(),
    orgId: '',
    userId: ids.uuid(),
    email: `member${n}@postly.test`,
    name: `Member ${n}`,
  }),
  traits: { admin: { role: 'admin' } },
  belongsTo: { org: belongsTo(orgFactory, 'orgId') },
});
const postBase = defineFactory(posts, {
  defaults: (n, ids) => ({
    id: ids.uuid(),
    orgId: '',
    authorId: '',
    slug: `post-${n}`,
    title: `Post ${n}`,
    excerpt: `Excerpt ${n}`,
    body: `Body ${n}`,
  }),
  traits: { published: { status: 'published', publishedAt: new Date('2026-01-05T09:00:00Z') } },
  belongsTo: { org: belongsTo(orgFactory, 'orgId'), author: belongsTo(memberFactory, 'authorId') },
});
export const commentFactory = defineFactory(comments, {
  defaults: (n, ids) => ({
    id: ids.uuid(),
    orgId: '',
    postId: '',
    authorId: '',
    body: `Comment ${n}`,
  }),
  belongsTo: {
    org: belongsTo(orgFactory, 'orgId'),
    post: belongsTo(postBase, 'postId'),
    author: belongsTo(memberFactory, 'authorId'),
  },
});
export const postFactory = postBase.extend({
  hasMany: { comments: hasMany(commentFactory, 'postId') },
});

/** The set the gate's factory lint reads, by this exact name. */
export const factories = { orgFactory, memberFactory, postFactory, commentFactory };
