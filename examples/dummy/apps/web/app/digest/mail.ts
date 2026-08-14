/**
 * The digest email. Rendered in the `worker` role with the member's locale and — the part that is
 * usually wrong — the member's timezone. `localDate` is computed once by the job, in the member's
 * zone, and travels as a string: nothing here reaches for a clock, so "yesterday" means yesterday
 * where the reader is rather than where the worker runs.
 *
 * `t` comes from @ultimat3/mail, not @ultimat3/schema: a mail file imports one package.
 */

import { blocks, defineMail, type Infer, t } from '@ultimat3/mail';
import { MemberView } from '../orgs/entity';
import { PostSummary } from '../posts/entity';

/**
 * `org` is the org's NAME, top-level for the same two reasons `mail.ts` in `posts/` spells out:
 * `{org}` is a name slot, and the subject interpolates from the payload's top level only.
 */
export const DigestData = t.object({
  member: MemberView,
  posts: t.array(PostSummary),
  localDate: t.string,
  org: t.string,
});

export type DigestData = Infer<typeof DigestData>;

export const digestEmail = defineMail<DigestData>({
  id: 'digest.daily',
  subject: 'digest.subject',
  input: DigestData,
  template: ({ data }) => [
    blocks.heading('digest.greeting', { name: data.member.name }),
    blocks.paragraph('digest.intro', { count: data.posts.length, org: data.org }),
    // Already localised by the job, so it is a value the renderer prints rather than a key it
    // has to format — a date without an explicit zone has no correct rendering here.
    blocks.detail('digest.date', data.localDate),
    ...data.posts.map((post) => blocks.detail('digest.post', post.title)),
    blocks.button('digest.readAction', '/feed'),
    blocks.paragraph('digest.footer', { zone: data.member.tz }),
  ],
});
