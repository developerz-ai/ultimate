/**
 * The whole admin dashboard. Screens, filters, forms and audit are derived from the entities;
 * authorisation is the app's existing policies, unchanged. Adding a feature adds an admin screen
 * and an MCP tool on the same day, not in a later quarter.
 */

import { comments, likes, members, orgs, plans, posts } from '@postly/db';
import { inviteMember, upgradePlan } from '@postly/web/app/orgs/actions';
import { publishPost } from '@postly/web/app/posts/actions';
import { defineAdmin } from '@ultimat3/admin';

export const admin = defineAdmin({
  title: 'Postly admin',
  /** Admin is scoped by the same tenant column as everything else — no god mode. */
  tenant: 'orgId',
  entities: [orgs, members, posts, comments, likes, plans],
  actions: [publishPost, inviteMember, upgradePlan],
  policies: { view: 'org:administer', edit: 'org:administer' },
  search: { posts: ['title', 'slug'], members: ['email', 'name'] },
  /** The user's own agents drive the user's own product, with the user's own permissions. */
  mcp: { expose: true, transport: 'ws' },
});
