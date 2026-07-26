/**
 * The API surface: every action, mutator and query Postly exposes, registered in one place.
 * Nothing else lives here — no rendering, no logic, no request handling. From this list the
 * framework projects HTTP routes, `openapi.json`, the typed client, job handles, MCP tools and
 * test scaffolds.
 */

import { defineApi } from '@ultimat3/action';
import { inviteMember, upgradePlan } from '../app/orgs/actions';
import { createComment, createPost, publishPost } from '../app/posts/actions';
import { liveFeed, postById, postBySlug, publicPost, publicPostSlugs } from '../app/posts/live';
import { toggleLike } from '../app/posts/mutator';
import { summarize } from '../app/posts/prompts/summarize';
import { savePreferences } from '../app/settings-actions';

export const api = defineApi({
  actions: {
    createPost,
    publishPost,
    createComment,
    inviteMember,
    upgradePlan,
    savePreferences,
  },
  mutators: {
    toggleLike,
  },
  queries: {
    liveFeed,
    postById,
    postBySlug,
    publicPost,
    publicPostSlugs,
  },
  llm: {
    summarize,
  },
});

export type Api = typeof api;
