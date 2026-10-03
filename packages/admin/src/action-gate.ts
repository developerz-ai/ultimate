// One decision, two consumers. `actionButtons()` decides what renders; `invokeAdminAction()`
// decides what runs — both call `decideAll()` with the same permissions against the same
// authz, so a button that renders is a call that is allowed and a call that is denied had no
// button. The admin's whole authz story is this file plus authz.ts.

import { actionLabelKey } from './action-label';
import { type AuditEntry, type AuditFieldDiff, type AuditLog, deniedDraft } from './audit';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminDecision,
  type AdminSubject,
  decideAll,
} from './authz';
import { atomicallyAudited } from './crud-outcome';
import { AdminActionNotApplicableError } from './errors';
import {
  ADMIN_DESTROY,
  ADMIN_WRITE,
  CONFIRMATION_REQUIRED_REASON,
  confirmationToken,
} from './permissions';
import { type AdminAction, type AdminActionCtx, type AdminRow, computedRow } from './registry';
import { type ValidationIssue, validateInput } from './validate';

export interface AdminActionButton {
  readonly name: string;
  readonly labelKey: string;
  readonly destructive: boolean;
  readonly permission: string;
  readonly entity: string | null;
  /** The action declares an input schema: its control is a link to its form, never a bare post. */
  readonly form: boolean;
  /** Carried so the `/_x` policy panel can show why this button is on screen. */
  readonly decision: AdminDecision;
}

/**
 * The reason on a `failed` action entry. A key the view renders — never a sentence carried out of
 * a caught value, which is how a database message or an attacker's string reaches an audit log.
 */
const ACTION_FAILED_REASON = 'admin.error.action-failed';

/** The reason an action refused by its own `when()` is answered and audited with. */
export const ACTION_NOT_APPLICABLE_REASON = 'admin.error.action-not-applicable';

/** The reason an action whose input its own schema refused is audited with. */
const ACTION_INVALID_REASON = 'admin.error.invalid-input';

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
  /** The resource's sealed column names: dropped from the row a `when` is handed. */
  readonly sealed?: readonly string[];
}

const isRow = (value: unknown): value is AdminRow => typeof value === 'object' && value !== null;

/**
 * Whether `action` applies to the subject's row — the ONE evaluation of `when`, asked by the
 * button and by the call behind it.
 *
 * A subject with no row at all (`undefined`: a toolbar, a batch bar) is not a row to refuse. A row
 * that was looked for and not found (`null`) is refused, `when` or none — an action on a row is an
 * action on THAT row, and a row the actor's scope leaves out is not there. No `when`: any row
 * applies. A `when` that throws is a refusal too: the rule did not say yes.
 */
export function actionApplies<Input, Output>(
  action: AdminAction<Input, Output>,
  subject: AdminSubject | undefined,
  sealed: readonly string[] = [],
): boolean {
  if (subject === undefined || subject.row === undefined) return true;
  // Looked for and not there — or outside the actor's `rows` — is refused for EVERY action, not
  // only one that declares `when`: an action with no rule about a row's state still acts on a row,
  // and running its handler on an id the actor cannot see was a way round the row scope.
  if (!isRow(subject.row)) return false;
  if (action.when === undefined) return true;
  try {
    return action.when(computedRow(subject.row, sealed)) === true;
  } catch {
    return false;
  }
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

/**
 * Only the buttons this actor may press ON THIS ROW. A denied action has no button, ever, and
 * neither has one whose `when` excludes the row.
 */
export function actionButtons(input: ActionGateInput): readonly AdminActionButton[] {
  return actionDecisions(input)
    .filter(({ decision }) => decision.allowed)
    .filter(({ action }) => actionApplies(action, input.subject, input.sealed))
    .map(({ action, decision }) => ({
      name: action.name,
      labelKey: actionLabelKey(action),
      destructive: action.destructive === true,
      permission: action.permission,
      entity: action.entity ?? null,
      form: action.input !== undefined,
      decision,
    }));
}

export type InvokeResult<Output> =
  | { readonly ok: true; readonly value: Output; readonly audit: AuditEntry }
  | {
      readonly ok: false;
      readonly kind: 'denied';
      readonly decision: AdminDecision;
      readonly confirmationRequired: boolean;
      readonly audit: AuditEntry;
    }
  /** The action's `when()` excludes the row. `error` is `X_ADMIN_ACTION_NOT_APPLICABLE`. */
  | {
      readonly ok: false;
      readonly kind: 'not-applicable';
      readonly decision: AdminDecision;
      readonly error: AdminActionNotApplicableError;
      readonly audit: AuditEntry;
    }
  /** The action's own input schema refused what was sent: one issue per field. */
  | {
      readonly ok: false;
      readonly kind: 'invalid';
      readonly issues: readonly ValidationIssue[];
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
  /** The resource's sealed column names: dropped from the row a `when` is handed. */
  readonly sealed?: readonly string[];
  /**
   * Echo of `confirmationToken(entity, subject.id)`. Required for a destructive action, and the
   * gate DERIVES the token it compares against — it took the caller's `expectedConfirmation`
   * until 22.0.0, and with both omitted `undefined !== undefined` ran the action unconfirmed.
   *
   * A type-to-confirm guard against ACCIDENTS, the same design as `adminDestroy`: the token is not
   * a secret, and a hostile caller can compute it. What stops that caller is the `admin:destroy`
   * permission this gate checks first.
   */
  readonly confirmation?: string;
  readonly locale?: string;
  readonly timeZone?: string;
  /** Before/after of the affected row, when the caller knows it. Always logged. */
  readonly diff?: readonly AuditFieldDiff[];
}

/**
 * Run an admin action on one subject. In this order: the policy, the action's own `when()` over
 * the row as it is now, the confirmation, the action's input schema, the handler — and every one
 * of the five outcomes is audited before this function returns. The button, the batch bar and the
 * MCP tool all end here, so there is one ordering of those steps and not one per surface.
 */
export async function invokeAdminAction<Input, Output>(
  args: InvokeInput<Input, Output>,
): Promise<InvokeResult<Output>> {
  const { action, actor, authz, audit, requestId } = args;
  const entity = action.entity ?? 'admin';
  const entityId = args.subject?.id ?? null;
  const decision = decideAction(action, actor, authz, args.subject);

  const entry = {
    requestId,
    actor,
    operation: action.name,
    kind: 'action',
    entity,
    entityId,
  } as const;

  if (!decision.allowed) {
    return {
      ok: false,
      kind: 'denied',
      decision,
      confirmationRequired: false,
      audit: await audit.append(deniedDraft({ ...entry, decision })),
    };
  }

  // After the grant, before anything else: the same `when` that decided the button, asked of the
  // row as it is NOW. A hidden button is not an authorization.
  if (!actionApplies(action, args.subject, args.sealed)) {
    const refused: AdminDecision = {
      allowed: false,
      permission: action.permission,
      reason: ACTION_NOT_APPLICABLE_REASON,
      trace: [`when: ${action.name} does not apply to ${entity} ${entityId ?? '(no row)'}`],
    };
    return {
      ok: false,
      kind: 'not-applicable',
      decision: refused,
      error: new AdminActionNotApplicableError({ action: action.name, entity, id: entityId }),
      audit: await audit.append(deniedDraft({ ...entry, decision: refused })),
    };
  }

  const expected = confirmationToken(entity, entityId ?? '');
  if (action.destructive === true && args.confirmation !== expected) {
    const refused: AdminDecision = {
      allowed: false,
      permission: ADMIN_DESTROY,
      reason: CONFIRMATION_REQUIRED_REASON,
      trace: [`confirmation: expected "${expected}"`],
    };
    return {
      ok: false,
      kind: 'denied',
      decision: refused,
      confirmationRequired: true,
      audit: await audit.append(deniedDraft({ ...entry, decision: refused })),
    };
  }

  // The action's own schema judges its own input. The row's `id` is the admin's envelope and is
  // no property of that schema, so it rides around the parse and is put back for the handler.
  let input = args.input;
  if (action.input !== undefined) {
    const { id, ...own } = { ...(args.input as Readonly<Record<string, unknown>>) };
    const parsed = await validateInput(action.input, own);
    if (!parsed.ok) {
      return {
        ok: false,
        kind: 'invalid',
        issues: parsed.issues,
        audit: await audit.append({
          ...entry,
          permission: action.permission,
          outcome: 'failed',
          reason: ACTION_INVALID_REASON,
          diff: [],
        }),
      };
    }
    input = { ...parsed.value, ...(id === undefined ? {} : { id }) } as Input;
  }

  const ctx: AdminActionCtx = {
    requestId,
    actorId: actor.id,
    locale: args.locale ?? actor.locale ?? 'en',
    timeZone: args.timeZone ?? actor.timeZone ?? 'UTC',
  };

  // The handler and its entry are ONE unit (`atomicallyAudited`): a handler whose writes ride the
  // ambient transaction commits with its `allowed` entry or not at all, and a throw from either
  // leaves exactly one `failed` entry, appended after the rollback, with nothing read off the
  // thrown value — which reaches the caller unchanged.
  const { value, audit: appended } = await atomicallyAudited(
    audit,
    {
      requestId,
      actor,
      operation: action.name,
      kind: 'action',
      entity,
      permission: action.permission,
    },
    { allowed: decision.reason, failed: ACTION_FAILED_REASON },
    entityId,
    () => action.handle({ input, ctx }),
    () => ({ entityId, diff: args.diff ?? [] }),
  );
  return { ok: true, value, audit: appended };
}
