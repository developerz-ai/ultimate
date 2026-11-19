// The tenant half of a channel: a param that names a records entity's tenant column must be the
// subscriber's own org, decided at subscribe by `@ultimat3/entity`'s own guard (`assertScoped`); a
// tenanted row on a topic NOT keyed by its tenant column reaches only that tenant's members.

import { type Actor, type Ctx, isUltimateError, runWithContext } from '@ultimat3/core';
import { assertScoped, type QueryPlan } from '@ultimat3/entity';
import { tenantColumnOfTable, tenantIn } from './change-tenant';
import type { Channel } from './channel-decl';
import type { ChannelRecordsFrame } from './channel-wire';
import { isTenancyDenial, TopicForbiddenError } from './errors';

/**
 * A row is routed to the topic its own params name (`channel-records.ts`), so a topic keyed by the
 * tenant column IS one tenant's stream — of records, and of the events and presence that ride the
 * same seat. Granting it on the policy alone handed org B's rows to any org-A member whose rule
 * forgot to compare the org (`can('post:read')` does not).
 *
 * The verdict is `assertScoped`'s over the plan the subscribe amounts to — `<column> = <param>`
 * under the subscriber's context: the actor's org or `X_TENANCY_ACTOR_MISMATCH`, no org at all
 * `X_TENANCY_ACTOR_ORG_REQUIRED`, a proven `crossTenant()` scope passes. A refusal reaches the
 * socket as `X_TOPIC_FORBIDDEN` naming that code, a denial the hub latches. Anything else the
 * guard raised is not a decision and leaves as it came.
 */
export function assertChannelTenant(
  channel: Channel,
  actor: Actor | null,
  topic: string,
  params: Readonly<Record<string, string>>,
  contextFor: (actor: Actor) => Ctx,
): void {
  let ctx: Ctx | undefined;
  for (const projection of channel.records) {
    const column = tenantColumnOfTable(projection.table);
    if (column === null || !channel.params.includes(column)) continue;
    const refusal = (code: string): TopicForbiddenError =>
      new TopicForbiddenError({
        topic,
        actorId: actor === null ? null : actor.id,
        reason: `channel "${channel.name}" carries "${projection.type}" rows by its tenant column "${column}", and this actor's tenant is not the one the param names (${code})`,
      });
    if (actor === null) throw refusal('X_TENANCY_ACTOR_ORG_REQUIRED');
    const plan: QueryPlan = {
      entity: projection.type,
      where: [{ column, op: 'eq', value: params[column] }],
      orderBy: [],
      limit: 1,
    };
    ctx ??= contextFor(actor);
    try {
      runWithContext(ctx, () => assertScoped(projection.type, column, 'subscribe', plan));
    } catch (error) {
      if (!isTenancyDenial(error) || !isUltimateError(error)) throw error;
      throw refusal(error.code);
    }
  }
}

/**
 * Who may read one change's rows on `channel`: `undefined` for everyone on the topic — an untenanted
 * table, or a channel keyed by the tenant column, whose subscribe already proved the tenant
 * (`assertChannelTenant`) — else the tenant `row` names, `null` when it names none (no member).
 *
 * A topic keyed by `roomId` carries every org's rows that name that room, and its policy decided a
 * permission, not a tenant: `can('message:read')` admitted org A to org B's room. The subscribe
 * cannot decide this (the rows are not known yet), so delivery and ring replay do, per row.
 */
export function rowTenant(
  channel: Channel,
  table: string,
  row: Readonly<Record<string, unknown>>,
): string | null | undefined {
  const column = tenantColumnOfTable(table);
  if (column === null || channel.params.includes(column)) return undefined;
  return tenantIn(column, row);
}

/**
 * `assertScoped`'s verdict for a plan naming `tenant`, without a context to run it in: the actor's
 * own org, and nothing else. A `crossTenant()` scope is never open around a delivery — it is a
 * change, not a call — so there is no proof of one to honour here.
 */
export function admitsTenant(actor: Actor | null, tenant: string | null | undefined): boolean {
  if (tenant === undefined) return true;
  return tenant !== null && actor !== null && actor.orgId !== undefined && actor.orgId === tenant;
}

/**
 * A records frame's audience when it carries one tenant's rows (`rowTenant`): a member `admits`
 * takes gets the frame, every other member `withheld` — the same seq, carrying nothing.
 */
export interface Audience {
  readonly admits: (actor: Actor | null) => boolean;
  readonly withheld: ChannelRecordsFrame;
}
