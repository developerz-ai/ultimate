// The two answers to a friend request, as a real form.
//
// A form and not a click handler: this screen ships 0kb of JS — the framework has no client bundler
// yet — and `POST /api/friends/respond` already parses `application/x-www-form-urlencoded`, so the
// buttons work with nothing loaded. The same `respondFriend` action answers the form, the typed
// client and the MCP tool, which is the one authz path rather than three.

import { t } from '@ultimat3/i18n';
import { Button, Stack } from '@ultimat3/ui';
import type { JSX } from 'solid-js';

export interface RespondFormProps {
  /** Who asked. The action loads the row by `(requesterId, caller)` and decides on that, not on this. */
  readonly requesterId: string;
}

const RESPOND_PATH = '/api/friends/respond';

/** One form per decision: a single form with two submit buttons needs JS to know which one won. */
export function RespondForm(props: RespondFormProps): JSX.Element {
  return (
    <Stack direction="row" gap={2} align="center">
      <form method="post" action={RESPOND_PATH}>
        <input type="hidden" name="requesterId" value={props.requesterId} />
        <input type="hidden" name="decision" value="accept" />
        <Button type="submit" size="sm" variant="primary">
          {t('app.friends.accept')}
        </Button>
      </form>
      <form method="post" action={RESPOND_PATH}>
        <input type="hidden" name="requesterId" value={props.requesterId} />
        <input type="hidden" name="decision" value="decline" />
        <Button type="submit" size="sm" variant="secondary" tone="danger">
          {t('app.friends.decline')}
        </Button>
      </form>
    </Stack>
  );
}
