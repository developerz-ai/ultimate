/**
 * One agent token for a person in several orgs — `defineAppMcp({ tenant })`. The token resolves to
 * the PERSON; every call names the org it acts in as `org`, and `resolve` turns the person's
 * membership of that org into the member actor every Postly policy already reads (`memberOf`: the
 * actor id IS the member id). An org they are not in is `null`, which answers as a hidden tool.
 *
 * Where the memberships come from is the app's (`PostlyMcpApp.memberships`): an issued token's
 * claims, or a members lookup by the person's identity — this package never reads `@postly/db`.
 */

import { isMemberRole, type MemberRole } from '@postly/domain';
import type { Actor } from '@ultimat3/core';
import { agentActor } from '@ultimat3/core';
import type { McpTenant } from '@ultimat3/mcp';

/** One org a person belongs to, as the member row there. */
export interface PostlyMembership {
  readonly orgId: string;
  readonly memberId: string;
  readonly role: MemberRole;
  /** What `list_tenants` shows beside the id. */
  readonly orgName?: string;
}

/** The person's memberships, asked per call: a membership revoked mid-session stops the next call. */
export type PostlyMemberships = (
  person: Actor,
) => Promise<readonly PostlyMembership[]> | readonly PostlyMembership[];

/** The tenant argument Postly's agents name an org by. */
export const POSTLY_TENANT_ARG = 'org';

export const postlyTenant = (memberships: PostlyMemberships): McpTenant => ({
  arg: POSTLY_TENANT_ARG,
  async resolve({ person, value }) {
    const member = (await memberships(person)).find((one) => one.orgId === value);
    // A role this app does not know is no membership: fail closed, as `memberOf` does.
    if (member === undefined || !isMemberRole(member.role)) return null;
    return agentActor({ id: member.memberId, orgId: member.orgId, roles: [member.role] });
  },
  async list({ person }) {
    return (await memberships(person)).map((member) => ({
      value: member.orgId,
      ...(member.orgName === undefined ? {} : { name: member.orgName }),
    }));
  },
});
