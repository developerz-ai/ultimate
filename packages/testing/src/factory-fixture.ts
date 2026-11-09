// A three-table tenant graph and its factories, shared by the factory suites: orgs (the tenant
// root), posts (tenant-scoped, belongs to an org), comments (tenant-scoped, belongs to a post).
// A fixture, so it never ships (`!src/**/*-fixture.ts`).

import {
  type AnyColumn,
  entity,
  integer,
  memoryDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { defineFactory } from './factories';
import { belongsTo, hasMany } from './factory-associations';
import { entityPersister, usePersister } from './factory-persist';

export const orgs = entity('ff_orgs', { columns: { id: uuid().primaryKey(), name: text() } });
export const posts = entity('ff_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
    views: integer().default(0),
    createdAt: timestamp().defaultNow(),
  },
});
export const comments = entity('ff_comments', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    postId: uuid().references((): AnyColumn => posts.id),
    body: text(),
  },
});

/** Fresh factories AND a fresh driver per test: sequences and rows both start empty. */
export function factoryWorld() {
  const driver = memoryDriver();
  usePersister(entityPersister({ driver }));
  const orgFactory = defineFactory(orgs, {
    defaults: (n, ids) => ({ id: ids.uuid(), name: `org-${n}` }),
  });
  const postBase = defineFactory(posts, {
    defaults: (n, ids) => ({ id: ids.uuid(), orgId: '', title: `post-${n}` }),
    traits: { popular: (n) => ({ views: n * 100 }), titled: { title: 'titled' } },
    transient: { shout: false },
    belongsTo: { org: belongsTo(orgFactory, 'orgId') },
    afterBuild: (row, { transient }) => {
      if (transient.shout) row.title = row.title.toUpperCase();
    },
  });
  const commentFactory = defineFactory(comments, {
    defaults: (n, ids) => ({ id: ids.uuid(), orgId: '', postId: '', body: `comment-${n}` }),
    belongsTo: { org: belongsTo(orgFactory, 'orgId'), post: belongsTo(postBase, 'postId') },
  });
  // The two-way association closes here, after both ends exist: one sequence with `postBase`.
  const postFactory = postBase.extend({ hasMany: { comments: hasMany(commentFactory, 'postId') } });
  return { driver, orgFactory, postFactory, commentFactory };
}
