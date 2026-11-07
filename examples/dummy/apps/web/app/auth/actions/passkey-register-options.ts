// `passkeyRegisterOptions` — a signed-in member adding a passkey to their own account: the
// creation options `newPasskey(options)` takes. Only their own: the user id is the actor's.

import { action, t } from '@ultimat3/action';
import { memberSelf } from '../../orgs/policy';
import { passkeys } from '../passkeys';

export const passkeyRegisterOptions = action({
  input: t.object({}),
  output: t.json(),
  policy: memberSelf,
  errors: ['X_PASSKEY_INVALID'],
  handle: ({ ctx }) => passkeys.login.registerOptions({ userId: ctx.actor.id }),
});
