// Single responsibility: reading accounts back out, safely. A quarterly access review — "who in
// this org holds `admin`, and is any of them gone?" — was unanswerable: `UserStore` could find one
// user by address or by id and nothing else, so there was no way to enumerate an org's members at
// all. The projection is `describeApiKey`'s shape and its rule: never the password hash, never the
// TOTP secret, never a recovery code hash.

import type { AuthUser, UserQuery } from './adapter';
import type { Auth } from './auth';
import { authNotImplemented } from './errors';

/** Safe to render in an admin page, return from an MCP tool, or paste into a review ticket. */
export interface AuthUserSummary {
  readonly id: string;
  readonly email: string;
  readonly orgId: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly externalId: string | null;
  /** Whether a second factor is enrolled. The secret itself never leaves the server. */
  readonly mfaEnrolled: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

/**
 * The one projection. An allow-list rather than a delete-list, because a column added to
 * `AuthUser` later must not appear here by default — that is how a `mfaSecret` ends up in an
 * admin JSON response one refactor after somebody was careful.
 */
export function describeUser(user: AuthUser): AuthUserSummary {
  return {
    id: user.id,
    email: user.email,
    orgId: user.orgId,
    roles: user.roles,
    permissions: user.permissions,
    scopes: user.scopes,
    externalId: user.externalId,
    mfaEnrolled: user.mfaSecret !== null,
    emailVerifiedAt: user.emailVerifiedAt,
    disabledAt: user.disabledAt,
    createdAt: user.createdAt,
  };
}

const unsupported = (method: string, adapterName: string) =>
  authNotImplemented(
    `${adapterName}.${method}()`,
    `implement ${method}() on your AuthAdapter — BuiltinAdapter (Postgres) and MemoryAdapter are the two reference implementations, in packages/auth/src`,
  );

/** Every member of one org, as summaries. `query.role` narrows it to one role's holders. */
export async function listOrgUsers(
  auth: Auth,
  orgId: string,
  query?: UserQuery,
): Promise<readonly AuthUserSummary[]> {
  const list = auth.adapter.listUsersByOrg?.bind(auth.adapter);
  if (list === undefined) throw unsupported('listUsersByOrg', auth.adapter.name);
  return (await list(orgId, query)).map(describeUser);
}

/**
 * The account a provisioning system already knows by its own id. This is what a SCIM `PUT` or
 * `PATCH` resolves against — an email address cannot be, because a rename changes it and the
 * subject stays the same person.
 */
export async function findUserByExternalId(
  auth: Auth,
  externalId: string,
): Promise<AuthUser | null> {
  const find = auth.adapter.findUserByExternalId?.bind(auth.adapter);
  if (find === undefined) throw unsupported('findUserByExternalId', auth.adapter.name);
  return await find(externalId);
}
