// `printPost`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// A published post, printed to PDF on the org's disk. `pdf()` is a factory that RETURNS an
// `action`, so this is an action like its neighbours: schema, policy and rate limit are the
// action's, and HTTP, OpenAPI, the typed client and `.job()` come with it. It prints the post's
// PUBLIC page (`/blog/<slug>`): the printing browser carries no session, so a private route would
// need a short-lived token through `headers` (wiki Known gaps, "`pdf()` prints with no session").

import { t } from '@ultimat3/action';
import { pdf } from '@ultimat3/scraping';
import { disk, scopedKey } from '@ultimat3/storage';
import { blogHref } from '../../../shared/entities';
import { postExport } from '../policy';

/** The key a post's print lands under — the org's own prefix, one file per post. */
export const printedPostKey = (orgId: string, slug: string): string =>
  scopedKey(orgId, 'posts', 'printed', `${slug}.pdf`);

export const printPost = pdf({
  input: t.object({ orgId: t.uuid, slug: t.slug }),
  // No `mcp:` — `pdf()` takes none, so this is not agent-callable: each call launches a browser,
  // and an agent wanting a copy has `requestPostsExport`.
  // A copy of the org's content leaving the app as a file is an export: `post:export`'s holder.
  policy: postExport,
  route: ({ input }) => blogHref({ slug: input.slug }),
  key: ({ input }) => printedPostKey(input.orgId, input.slug),
  storage: () => disk(),
  layout: { format: 'a4', marginMm: { top: 15, right: 15, bottom: 15, left: 15 } },
});
