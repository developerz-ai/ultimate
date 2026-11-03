// The pure half of `x env init --production`: which keys the file carries, given a declaration,
// a compose file and the app's push setting. The command's own suite is `cmd-env-init.test.ts`.

import { describe, expect, test } from 'bun:test';
import { VAPID_PRIVATE_KEY_ENV, VAPID_PUBLIC_KEY_ENV } from '@ultimat3/pwa';
import { productionEnvFile } from './env-production';

const secret = () => 's'.repeat(64);

describe('unit · the .env.production text', () => {
  test('a push app gets the VAPID pair it was handed, never a random string for either half', () => {
    const env = productionEnvFile({
      schema: {},
      compose: undefined,
      facts: { push: true },
      secret,
      vapid: { publicKey: 'pub', privateKey: 'priv' },
    });
    expect(env.contents).toContain(`${VAPID_PUBLIC_KEY_ENV}=pub\n`);
    expect(env.contents).toContain(`${VAPID_PRIVATE_KEY_ENV}=priv\n`);
  });

  test('without push no VAPID key is written; a default or optional key is left to the boot', () => {
    const env = productionEnvFile({
      schema: {
        PORT: { type: 'port', default: 3000 },
        NATS_URL: { type: 'url', required: false },
      },
      compose: undefined,
      facts: { push: false },
      secret,
    });
    expect(env.written).not.toContain(VAPID_PUBLIC_KEY_ENV);
    expect(env.written).not.toContain('PORT');
    expect(env.written).not.toContain('NATS_URL');
    expect(env.unfilled).toEqual([]);
  });
});
