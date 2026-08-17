// The dashboard's one write door. The toolbar's buttons are `<form method="post">` submits at the
// route this action derives, so a control that renders is a call that runs — with `hydrate: 'never'`
// kept, because a native form needs no JavaScript.
//
// Declared as an `action` because that is what it is: a server-authoritative operation with an
// input schema, an output schema and a policy. `invokeAdminAction` is the decision — the same
// `decideAll` that decided whether the button rendered — so this file adds no second authz path.

import { action, t } from '@ultimat3/action';
import type { AdminAction } from '@ultimat3/admin';
import { confirmationToken, invokeAdminAction } from '@ultimat3/admin';
import { setRedirect, useRequestHeader } from '@ultimat3/http';
import { can } from '@ultimat3/policy';
import { admin, adminCtxForRequest } from '../app/admin/admin';
import { landsInBrowser } from '../shared/action-route';
import { AdminActionRefusedError, AdminActionUnknownError } from './errors';

/** One registered action with the entity it hangs off — `'admin'` for an app-wide one. */
interface ResolvedAdminAction {
  readonly action: AdminAction;
  readonly entity: string;
}

const declared = (): readonly ResolvedAdminAction[] => [
  ...admin.resources.flatMap((resource) =>
    resource.actions.map((registered) => ({ action: registered, entity: resource.name })),
  ),
  ...admin.globalActions.map((registered) => ({ action: registered, entity: 'admin' })),
];

/**
 * The posted name, resolved against the registry `defineAdmin()` built — never a lookup table this
 * file keeps. An unknown name is refused before any decision is asked, because "which operation is
 * this?" has to be answered before "may this actor run it?".
 */
export function adminActionFor(name: string): ResolvedAdminAction {
  const all = declared();
  const found = all.find((candidate) => candidate.action.name === name);
  if (found === undefined) {
    throw new AdminActionUnknownError({
      name,
      declared: all.map((candidate) => candidate.action.name),
    });
  }
  return found;
}

/** Back to the screen the form was pressed from. Derived from the route table, never from input. */
export function landingFor(entity: string): string {
  const resource = admin.resources.find((candidate) => candidate.name === entity);
  return resource === undefined ? admin.basePath : `${admin.basePath}${resource.path}`;
}

export const runAdminAction = action({
  input: t.object({
    name: t.string.min(1).max(120).describe('the registered admin action, e.g. user.suspend'),
    /**
     * Required, and not optional for an app-wide action: every action this dashboard declares acts
     * on a row, and a write with no subject is a write nobody can audit. An app-wide action would
     * arrive with its own field, not by making this one absent.
     */
    id: t.string.min(1).max(200),
    /** The destructive echo. `invokeAdminAction` ignores it for a non-destructive action. */
    confirmation: t.optional(t.string.max(200)),
  }),
  output: t.object({ ok: t.boolean, name: t.string, id: t.string, next: t.string }),
  /**
   * The coarse door, and deliberately not `admin:write`: the operation's own pair
   * (`admin:write | admin:destroy` plus the action's permission) is `invokeAdminAction`'s, and a
   * refusal there is written to the audit log. A route-level `admin:write` would refuse first and
   * record nothing, so the one thing an operator needs after a denial — the row saying who was
   * refused what — would exist only for the callers who got past the door.
   */
  policy: can('admin:read'),
  // Not a tool: an agent reaches these operations through `@ultimat3/admin`'s own MCP catalog,
  // which projects each admin action with its own permissions. This is the browser's door.
  mcp: { expose: false },
  async handle({ input, ctx }) {
    const { action: target, entity } = adminActionFor(input.name);
    const request = adminCtxForRequest();
    const result = await invokeAdminAction({
      action: target,
      input: { id: input.id },
      actor: request.actor,
      authz: request.authz,
      audit: request.audit,
      requestId: request.requestId,
      subject: { entity, id: input.id },
      ...(input.confirmation === undefined ? {} : { confirmation: input.confirmation }),
      expectedConfirmation: confirmationToken(entity, input.id),
      locale: ctx.locale,
      timeZone: ctx.tz,
    });

    if (!result.ok) {
      // Thrown, never redirected away from: the button only renders when the decision allows, so a
      // refusal here is a stale page, a hand-written POST, or a destructive echo that was not
      // given. Each of those is a fact the caller has to be told, and the `fix:` is the telling.
      throw new AdminActionRefusedError({
        name: input.name,
        permission: result.decision.permission,
        reason: result.decision.reason,
        expectedConfirmation: result.confirmationRequired
          ? confirmationToken(entity, input.id)
          : null,
      });
    }

    const next = landingFor(entity);
    if (landsInBrowser(useRequestHeader('accept'))) setRedirect(next);
    return { ok: true, name: input.name, id: input.id, next };
  },
});
