/**
 * One member's data, declared once: what `exportMember` hands back and what `eraseMember` does to
 * every table holding something of theirs. Every table with a key to `members` needs a line here —
 * add one without it and `x verify` is red naming it (`X_SUBJECT_TABLE_UNDECLARED`).
 *
 * Postly's rules, not the framework's: the member row is anonymized (posts and comments of others
 * hang off it), their published posts stay with the org that owns them, and what is only theirs —
 * likes, comments, reviews, the avatar — goes.
 */

import { driver, members } from '@postly/db';
import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import { defineSubject } from '@ultimat3/jobs';
import { attachmentPrefix, disk, storageSubjectTarget } from '@ultimat3/storage';
import { avatarTarget } from '../orgs/avatar';

export interface MemberSubjectInput {
  readonly orgId: string;
  readonly memberId: string;
}

/** What replaces the address: the shape `member_email_shape` accepts, on a reserved domain. */
export const ERASED_EMAIL = 'erased@postly.invalid';

export const memberSubject = defineSubject<MemberSubjectInput>(members, {
  driver,
  key: (input) => input.memberId,
  tables: {
    members: { anonymize: { email: ERASED_EMAIL, name: '' } },
    posts: { retain: 'published work belongs to the org; its author row is anonymized' },
    comments: 'delete',
    likes: 'delete',
    post_reviews: 'delete',
  },
  targets: [
    // Every avatar the member uploaded: listed from the prefix the upload grant derived.
    storageSubjectTarget(
      () => disk(),
      async ({ row }) => {
        const prefix = attachmentPrefix(
          toOrgId(String(row['orgId'])),
          avatarTarget(toMemberId(String(row['id']))),
        );
        return (await disk().list({ prefix })).rows.map((entry) => entry.key);
      },
      { name: 'avatars' },
    ),
  ],
});
