/**
 * Branded identifiers. A `PostId` where an `OrgId` is expected is a compile error, which is
 * the cheapest possible defence against cross-tenant argument swaps.
 */

declare const brand: unique symbol;

type Branded<Name extends string> = string & { readonly [brand]: Name };

export type OrgId = Branded<'OrgId'>;
export type MemberId = Branded<'MemberId'>;
export type PostId = Branded<'PostId'>;
export type CommentId = Branded<'CommentId'>;

/** Every id Postly issues is a UUID; the entity layer parses, these only re-tag. */
export const orgId = (value: string): OrgId => value as OrgId;
export const memberId = (value: string): MemberId => value as MemberId;
export const postId = (value: string): PostId => value as PostId;
export const commentId = (value: string): CommentId => value as CommentId;
