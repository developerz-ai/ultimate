// One decision, two consumers. `actionButtons()` decides what renders; `invokeAdminAction()`
// decides what runs — both call `decideAll()` with the same permissions against the same
// authz, so a button that renders is a call that is allowed and a call that is denied had no
// button. The admin's whole authz story is this file plus authz.ts.

import { type AuditEntry, type AuditFieldDiff, type AuditLog, deniedDraft } from './audit';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminDecision,
  type AdminSubject,
  decideAll,
} from './authz';
import { ADMIN_DESTROY, ADMIN_WRITE, CONFIRMATION_REQUIRED_REASON } from './permissions';
import type { AdminAction, AdminActionCtx } from './registry';

export interface AdminActionButton {
  readonly name: string;
  readonly labelKey: string;
  readonly destructive: boolean;
  readonly permission: string;
  readonly entity: string | null;
  /** Carried so the `/_x` policy panel can show why this button is on screen. */
  readonly decision: AdminDecision;
}

/**
 * The reason on a `failed` action entry. A key the view renders — never a sentence carried out of
 * a caught value, which is how a database message or an attacker's string reaches an audit log.
 */
const ACTION_FAILED_REASON = 'admin.error.action-failed';

/** The permissions an action needs: the admin-level gate, then the action's own policy. */
export function permissionsForAction<Input, Output>(
  action: AdminAction<Input, Output>,
): readonly string[] {
  return [action.destructive === true ? ADMIN_DESTROY : ADMIN_WRITE, action.permission];
}

export function decideAction<Input, Output>(
  action: AdminAction<Input, Output>,
  actor: AdminActor,
  authz: AdminAuthz,
  subject?: AdminSubject,
): AdminDecision {
  return decideAll(authz, permissionsForAction(action), actor, subject);
}

export interface ActionGateInput {
  readonly actions: readonly AdminAction[];
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly subject?: AdminSubject;
}

/** Every action with its decision — what the `/_x` policy panel and tests want to see. */
export function actionDecisions(
  input: ActionGateInput,
): readonly { readonly action: AdminAction; readonly decision: AdminDecision }[] {
  return input.actions.map((action) => ({
    action,
    decision: decideAction(action, input.actor, input.authz, input.subject),
  }));
}

/** Only the buttons this actor may press. A denied action has no button, ever. */
export function actionButtons(input: ActionGateInput): readonly AdminActionButton[] {
  return actionDecisions(input)
    .filter(({ decision }) => decision.allowed)
    .map(({ action, decision }) => ({
      name: action.name,
      labelKey: action.labelKey ?? `admin.action.${action.name}`,
      destructive: action.destructive === true,
      permission: action.permission,
      entity: action.entity ?? null,
      decision,
    }));
}

export type InvokeResult<Output> =
  | { readonly ok: true; readonly value: Output; readonly audit: AuditEntry }
  | {
      readonly ok: false;
      readonly decision: AdminDecision;
      readonly confirmationRequired: boolean;
      readonly audit: AuditEntry;
    };

export interface InvokeInput<Input, Output> {
  readonly action: AdminAction<Input, Output>;
  readonly input: Input;
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly audit: AuditLog;
  readonly requestId: string;
  readonly subject?: AdminSubject;
  /** Echo of `confirmationToken(entity, id)`. Required for a destructive action. */
  readonly confirmation?: string;
  readonly expectedConfirmation?: string;
  readonly locale?: string;
  readonly timeZone?: string;
  /** Before/after of the affected row, when the caller knows it. Always logged. */
  readonly diff?: readonly AuditFieldDiff[];
}

/**
 * Run an admin action. The policy is consulted first, the confirmation second, the handler
 * last, and all three outcomes are audited before this function returns.
 */
export async function invokeAdminAction<Input, Output>(
  args: InvokeInput<Input, Output>,
): Promise<InvokeResult<Output>> {
  const { action, actor, authz, audit, requestId } = args;
  const entity = action.entity ?? 'admin';
  const entityId = args.subject?.id ?? null;
  const decision = decideAction(action, actor, authz, args.subject);

  if (!decision.allowed) {
    return {
      ok: false,
      decision,
      confirmationRequired: false,
      audit: await audit.append(
        deniedDraft({
          requestId,
          actor,
          operation: action.name,
          kind: 'action',
          entity,
          entityId,
          decision,
        }),
      ),
    };
  }

  if (action.destructive === true && args.confirmation !== args.expectedConfirmation) {
    const refused: AdminDecision = {
      allowed: false,
      permission: ADMIN_DESTROY,
      reason: CONFIRMATION_REQUIRED_REASON,
      trace: [`confirmation: expected "${args.expectedConfirmation ?? ''}"`],
    };
    return {
      ok: false,
      decision: refused,
      confirmationRequired: true,
      audit: await audit.append(
        deniedDraft({
          requestId,
          actor,
          operation: action.name,
          kind: 'action',
          entity,
          entityId,
          decision: refused,
        }),
      ),
    };
  }

  const ctx: AdminActionCtx = {
    requestId,
    actorId: actor.id,
    locale: args.locale ?? actor.locale ?? 'en',
    timeZone: args.timeZone ?? actor.timeZone ?? 'UTC',
  };

  try {
    const value = await action.handle({ input: args.input, ctx });
    return {
      ok: true,
      value,
      audit: await audit.append({
        requestId,
        actor,
        operation: action.name,
        kind: 'action',
        entity,
        entityId,
        permission: action.permission,
        outcome: 'allowed',
        reason: decision.reason,
        diff: args.diff ?? [],
      }),
    };
  } catch (error) {
    // NOTHING is read off `error` before the append, and nothing is read off it at all.
    //
    // This built an `AdminDecision` first, whose `trace` rendered the caught value with
    // `String(error)` — and a `catch` binding is annotated by nobody, so it holds whatever an
    // app's handler threw. `Object.create(null)` has no `toString`, no `valueOf` and no
    // `Symbol.toPrimitive`, so `String(it)` raises `TypeError: No default value` from inside the
    // block that owes the auditor an entry: measured, ZERO entries, and the caller received the
    // TypeError instead of what was thrown. Ordering was the second half — the render ran BEFORE
    // `append`, so its throw skipped the append rather than merely spoiling one field.
    //
    // The decision object was also DEAD: only its `reason` was ever read, and `append` takes no
    // trace. So there is no destination for a rendered value here and `renderThrowable` is not
    // needed either — an audit reason is a key the view renders, never a sentence from a
    // database, an upstream or an attacker.
    await audit.append({
      requestId,
      actor,
      operation: action.name,
      kind: 'action',
      entity,
      entityId,
      permission: action.permission,
      outcome: 'failed',
      reason: ACTION_FAILED_REASON,
      diff: [],
    });
    throw error;
  }
}
