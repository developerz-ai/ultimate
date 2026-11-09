// `passkeySignInOptions` — the first leg of a usernameless passkey sign-in: a single-use challenge
// for `getPasskey(options)` in the browser. Anonymous by nature, and it names no account, so it
// tells a caller nothing about who has one.

import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { passkeys } from '../passkeys';

export const passkeySignInOptions = action({
  input: t.object({}),
  output: t.json(),
  policy: allow('passkey-sign-in'),
  handle: () => passkeys.login.loginOptions(),
});
