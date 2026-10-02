// What a refused screen renders and the audit entry it leaves. The wrapper that DECIDES is
// `guardedScreen()` in `screen-frame.tsx`: `routes.ts` never hands a host the author's component
// — it hands that screen, which asks the SAME `decideAll` every CRUD call and every nav item
// asks, audits the refusal through this file, and only then calls the author's code.

import { t } from '@ultimat3/i18n';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import { deniedDraft } from './audit';
import type { AdminDecision } from './authz';
import type { CrudCtx } from './crud';

/**
 * The refusal, rendered as the page. Not a redirect and not a 404: an operator who is missing a
 * grant needs to read WHICH permission refused them, which is the same string the audit row and
 * the `/_x` policy panel carry.
 */
export function AdminPageDenied(props: {
  readonly titleKey: string;
  readonly decision: AdminDecision;
}): JSX.Element {
  return (
    <section class="x-admin-denied" role="alert">
      <h1>{t(props.titleKey)}</h1>
      <p class={styles['refusal']}>
        {t('admin.denied.body', {
          permission: props.decision.permission,
          reason: props.decision.reason,
        })}
      </p>
    </section>
  );
}

/**
 * The audit entry of a refused SCREEN. The page is the subject, so its path is what the row
 * names — there is no entity and no row id to key a refused screen by. One writer, so a custom
 * page and a generated form's GET leave the same entry.
 */
export async function auditRefusal(
  ctx: CrudCtx,
  path: string,
  decision: AdminDecision,
): Promise<void> {
  await ctx.audit.append(
    deniedDraft({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'page',
      kind: 'operation',
      entity: path,
      decision,
    }),
  );
}
