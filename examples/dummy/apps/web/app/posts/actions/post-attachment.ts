// `requestPostAttachment` + `confirmPostAttachment`, the posts slice's upload pair — one
// `uploadFlow()` declaration, so the grant, the attach and the rule both halves share are one value.

import { postId } from '@postly/domain';
import { t, uploadFlow } from '@ultimat3/action';
import { postAttach } from '../policy';

/** A post's attachments live under `org/<org>/post/<id>/attachment/…`; the prefix is the record. */
const POST_ENTITY = 'post';

/**
 * Files a post's author hands its readers: images and PDFs, sniffed against `accept` on confirm.
 * 10 MB: a slide deck, not a video. SVG is out — it is a script once served back inline.
 */
const POST_ATTACHMENT_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const POST_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `request` signs a PUT under the actor's org's `pending/`; `confirm` moves it onto the post once
 * it is measured, sniffed and scanned (`apps/web/runtime.ts`'s `uploadScanner`). No `attached`:
 * a post holds any number of attachments and its prefix lists them, so no column records one.
 * The browser half is `uploadFile({ file, grant: client.requestPostAttachment })`.
 */
export const { request: requestPostAttachment, confirm: confirmPostAttachment } = uploadFlow({
  name: 'attachment',
  // Both halves' `row:` loader, read in the ACTING member's org (`ctx.posts.authorship`). Only a
  // uuid reaches the read: the column is a uuid, and anything else names no post at all.
  target: async ({ ctx, id }) => ({
    entity: POST_ENTITY,
    id: id ?? '',
    post:
      id === undefined || t.uuid.safeParse(id).issues !== undefined
        ? null
        : await ctx.posts.authorship(postId(id)),
  }),
  accept: POST_ATTACHMENT_ACCEPT,
  maxBytes: POST_ATTACHMENT_MAX_BYTES,
  policy: postAttach,
});
