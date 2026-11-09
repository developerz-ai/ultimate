// `registerPasskey` — `newPasskey`'s answer in, the credential stored under the actor. A
// challenge issued to one account cannot register a key onto another: the framework checks.

import { action, t } from '@ultimat3/action';
import { memberSelf } from '../../orgs/policy';
import { passkeys } from '../passkeys';

export const registerPasskey = action({
  input: t.object({ response: t.json() }),
  output: t.object({ credentialId: t.string }),
  policy: memberSelf,
  errors: ['X_PASSKEY_INVALID', 'X_PASSKEY_CHALLENGE_EXPIRED'],
  async handle({ input, ctx }) {
    const stored = await passkeys.login.register({
      userId: ctx.actor.id,
      response: input.response,
    });
    return { credentialId: stored.id };
  },
});
