/** Errors the posts feature can raise. Codes are stable; the message names the fix. */

// No `docs:` at any declaration below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { defineError } from '@ultimat3/core/page';

/**
 * 404, declared in the same call as the code. Until 2026-11 this was a handwritten subclass with no
 * status row, so "post not found" answered 500, hid its cause from the caller and paged the error
 * monitor — the defect `guards/error-declared.ts` now refuses.
 */
export const PostNotFound = defineError<string>({
  code: 'X_POST_NOT_FOUND',
  title: "no such post in the actor's organisation",
  status: 404,
  cause: (reference) =>
    `no post ${JSON.stringify(reference)} in the actor's organisation — a reference owned ` +
    'by another org is a denial, never a 404 by accident',
  fix: 'psql "$DATABASE_URL" -c "SELECT id, slug FROM posts WHERE org_id = \'<ctx.actor.orgId>\'"',
});

/**
 * 409: the public blog's `/blog/{slug}` is one namespace across every org (`post_slug_unique`),
 * and a draft's slug is derived from its title — so two orgs' same title is a refusal the caller
 * acts on, not the database's 23505 escaping as `X_ERROR_UNDECLARED`.
 */
export const PostSlugTaken = defineError<string>({
  code: 'X_POST_SLUG_TAKEN',
  title: 'another post already holds this slug',
  status: 409,
  cause: (slug) =>
    `slug ${JSON.stringify(slug)} is held by another post — /blog/{slug} is one namespace ` +
    'across every org, so a slug is unique in all of them',
  fix: "createPost({ ...input, slug: '<an-unused-slug>' })   # or a title that slugifies differently",
});

/**
 * 404 for an export job the acting org does not have — one answer whether the id names nothing or
 * another org's export: `jobStatusFor`/`cancelJobFor` cannot tell the two apart, by design, so
 * neither can a caller probing ids.
 */
export const PostsExportNotFound = defineError<string>({
  code: 'X_POSTS_EXPORT_NOT_FOUND',
  title: "no such posts export in the actor's organisation",
  status: 404,
  cause: (jobId) => `no posts export job ${JSON.stringify(jobId)} in the actor's organisation`,
  fix: 'requestPostsExport({ orgId })   # pass the jobId it answers to postsExportStatus/cancelPostsExport',
});

/** 503: reading or cancelling an export needs the job queue, and this process installed none. */
export const PostsExportQueueUnavailable = defineError<string>({
  code: 'X_POSTS_EXPORT_QUEUE_UNAVAILABLE',
  title: 'this process has no job queue to read an export from',
  status: 503,
  cause: (what) => `${what} needs the job queue, and this process installed no job driver`,
  fix: 'x dev',
});
