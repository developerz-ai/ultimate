// Single responsibility: which VAPID pair this process signs with — read from the environment, the
// published development pair in development/test, and a refusal everywhere else.
//
// The cursor secret's rule, applied to a key pair (`@ultimat3/core`'s `devSecretsRefused`): a local
// process works with no setup at all, and a deployed one that would sign with keys printed in this
// file is refused at boot. Both halves come from the environment, never one from `app.config.ts`:
// a public key in committed config and a private key per deploy are two places that can disagree,
// and the disagreement is a 403 on every send.

import { devSecretsRefused, timingSafeEqual } from '@ultimat3/core';
import { PwaVapidKeyMissingError } from './errors';
import type { VapidKeyPair } from './vapid';
import { assertVapidPair, VAPID_PRIVATE_KEY_ENV, VAPID_PUBLIC_KEY_ENV } from './vapid';

/**
 * PUBLISHED, and so worthless outside one machine: the pair a development or test process signs
 * with when neither variable is set. A subscription made against it lives in that machine's
 * database. Refused by the boot anywhere `devSecretsRefused` holds, exactly as the dev cursor key is.
 */
export const DEV_VAPID_KEYS: VapidKeyPair = Object.freeze({
  publicKey:
    'BBwNsQrlkkkQ3pNRIpJVgq1VQk-Q6hG49IqxMDe-4X9Ks_5mUZcXb49zGt_vmJ1vNxy43CtF0CgANw8TXj6pA-c',
  privateKey: 'qkWoagc9adrZnnpYJpI3kM9DjA8B_5qJkJj7Yi9izLM',
});

type EnvTable = Readonly<Record<string, string | undefined>>;

const read = (env: EnvTable, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/**
 * True while `env` would leave a process signing with `DEV_VAPID_KEYS`: neither variable set, or
 * the published private key pasted back in. `x env check` and `x doctor` ask it of a deploy's table.
 */
export function usesDevVapidKeys(env: EnvTable): boolean {
  const privateKey = read(env, VAPID_PRIVATE_KEY_ENV);
  return privateKey === undefined || timingSafeEqual(privateKey, DEV_VAPID_KEYS.privateKey);
}

export interface ResolvedVapidKeys {
  readonly keys: VapidKeyPair;
  /** `'environment'` or `'development'` — logged once at boot, so a reader knows which pair. */
  readonly source: 'environment' | 'development';
}

/**
 * The pair, checked: both halves present (or neither, locally), each well-formed, and the private
 * half signing for the public one. Half a pair is refused in EVERY environment — a developer who
 * set one variable meant to set both, and silently signing with the dev pair would subscribe their
 * browser to a key their production deploy never holds.
 */
export async function resolveVapidKeys(env: EnvTable): Promise<ResolvedVapidKeys> {
  const publicKey = read(env, VAPID_PUBLIC_KEY_ENV);
  const privateKey = read(env, VAPID_PRIVATE_KEY_ENV);
  if (publicKey !== undefined && privateKey !== undefined) {
    const keys = { publicKey, privateKey };
    if (devSecretsRefused({ env }) && timingSafeEqual(privateKey, DEV_VAPID_KEYS.privateKey)) {
      throw new PwaVapidKeyMissingError({ missing: [VAPID_PRIVATE_KEY_ENV], deployed: true });
    }
    await assertVapidPair(keys);
    return { keys, source: 'environment' };
  }
  const missing = [
    ...(publicKey === undefined ? [VAPID_PUBLIC_KEY_ENV] : []),
    ...(privateKey === undefined ? [VAPID_PRIVATE_KEY_ENV] : []),
  ];
  const deployed = devSecretsRefused({ env });
  if (missing.length === 1 || deployed) throw new PwaVapidKeyMissingError({ missing, deployed });
  return { keys: DEV_VAPID_KEYS, source: 'development' };
}
