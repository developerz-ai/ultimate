// Lifting a block, as a form for the same reason `respond-form.tsx` is one.
//
// The control is rendered because `blockDelete` allows it — the same decision that answers the call
// — and NOT because the row happens to be in the list. That is the `admin/admin` rule applied here:
// view-only is a permission, never a hidden button. The call is idempotent: submitting it for a
// person who is not blocked answers with the same pair rather than an error.

import { t } from '@ultimat3/i18n';
import { Button } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

export interface UnblockFormProps {
  readonly userId: string;
}

export function UnblockForm(props: UnblockFormProps): JSX.Element {
  return (
    <form method="post" action="/api/users/unblock">
      <input type="hidden" name="userId" value={props.userId} />
      <Button type="submit" size="sm" variant="secondary">
        {t('app.friends.unblock')}
      </Button>
    </form>
  );
}
