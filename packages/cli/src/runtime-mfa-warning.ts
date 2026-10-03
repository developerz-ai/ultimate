// The web role's boot asks once whether `x auth seal-mfa` still has work to do (wiki/Upgrading.md,
// the operator step for sealed MFA secrets). `x doctor` asks the same question only when someone
// runs it; an unsealed secret is a user refused at the second factor, so the boot says so too.

import { BuiltinAdapter, countUnsealedMfaSecrets } from '@ultimat3/auth';
import { logger } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';

/**
 * Answers the count it logged, `0` when there was nothing to say or nothing could be asked. Never
 * throws: a database that cannot answer this is the readiness check's to report, not a reason for
 * a pod to refuse traffic its other users can be served.
 */
export async function warnUnsealedMfaSecrets(client: DbClient): Promise<number> {
  let unsealed = 0;
  try {
    unsealed = await countUnsealedMfaSecrets({ adapter: new BuiltinAdapter(client) });
  } catch {
    return 0;
  }
  if (unsealed === 0) return 0;
  logger.warn('X_MFA_SECRET_UNSEALED', {
    code: 'X_MFA_SECRET_UNSEALED',
    cause: `${unsealed} user(s) hold a second-factor secret that is not sealed; the framework never reads a plaintext secret, so each of them is refused at the second factor until it is sealed`,
    fix: 'x auth seal-mfa --json',
    unsealed,
  });
  return unsealed;
}
