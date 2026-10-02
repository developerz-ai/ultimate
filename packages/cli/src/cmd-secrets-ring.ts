// `x secrets rotate`'s key ring: the retired master keys kept in the sealed file so a value
// `seal()` wrote under the previous key still opens after a rotation. Pure over the decrypted
// map — `cmd-secrets.ts` owns the files and the terminal; `@ultimat3/core` owns the variable's
// name and how a process reads it.

import type { SecretValues } from '@ultimat3/core';
import {
  masterKeyId,
  parseMasterKey,
  SECRETS_FILE,
  SECRETS_RETIRED_KEYS_ENV,
  splitRetiredKeys,
} from '@ultimat3/core';
import { BadFlagError } from './errors';
import { quoteArg } from './shell-quote';

/** The app's own secrets: the ring is the framework's entry, never one `envSchema` declares. */
export function appSecrets(values: SecretValues): SecretValues {
  const { [SECRETS_RETIRED_KEYS_ENV]: _ring, ...rest } = values;
  return rest;
}

const withRing = (values: SecretValues, ring: readonly string[]): SecretValues =>
  ring.length === 0
    ? appSecrets(values)
    : { ...values, [SECRETS_RETIRED_KEYS_ENV]: ring.join(',') };

const idOf = (hex: string, index: number): Promise<string> =>
  masterKeyId(
    parseMasterKey(
      hex,
      `${SECRETS_RETIRED_KEYS_ENV} (entry ${index + 1}) in ${SECRETS_FILE}`,
      SECRETS_RETIRED_KEYS_ENV,
    ),
  );

/** The ids of the keys the file still declares as retired, newest first. Safe to print. */
export function retiredKeyIds(values: SecretValues): Promise<readonly string[]> {
  return Promise.all(splitRetiredKeys(values[SECRETS_RETIRED_KEYS_ENV]).map(idOf));
}

/**
 * The values a rotation seals: the same ones, with the key being replaced put at the head of the
 * ring. Kept by DEFAULT and never behind a flag — the rotation overwrites the only copy of the old
 * key on disk, so a rotation that did not keep it would make every sealed value unreadable with
 * nothing left to recover it from.
 */
export function retire(values: SecretValues, previousHex: string): SecretValues {
  const ring = splitRetiredKeys(values[SECRETS_RETIRED_KEYS_ENV]);
  return withRing(values, [previousHex, ...ring.filter((hex) => hex !== previousHex)]);
}

/** The values without one retired key, named by id — or `X_CLI_BAD_FLAG` listing the ids there are. */
export async function dropRetired(values: SecretValues, keyId: string): Promise<SecretValues> {
  const ring = splitRetiredKeys(values[SECRETS_RETIRED_KEYS_ENV]);
  const ids = await retiredKeyIds(values);
  if (!ids.includes(keyId)) {
    const [first] = ids;
    throw new BadFlagError({
      flag: 'drop',
      command: 'secrets rotate',
      reason:
        first === undefined
          ? `${SECRETS_FILE} declares no retired master key, so there is none to drop`
          : `no retired master key has that id — ${SECRETS_FILE} declares ${ids.join(', ')}`,
      fix:
        first === undefined
          ? 'x secrets show --json'
          : `x secrets rotate --drop ${quoteArg(first)} --json`,
    });
  }
  return withRing(
    values,
    ring.filter((_hex, index) => ids[index] !== keyId),
  );
}
