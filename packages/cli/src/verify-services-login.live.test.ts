// `postgresLogin` against the real test server: our credentials log in, and the same server under
// a wrong password is `refused` — the answer that tells another app's stack from ours.

import { describe, expect, test } from 'bun:test';
import { postgresLogin } from './verify-services';

const url = Bun.env['TEST_DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('postgresLogin · a real server', () => {
  test('the declared login is ok, a wrong password is refused', async () => {
    const ours = new URL(String(url));
    expect(await postgresLogin(ours.href)).toBe('ok');
    ours.password = 'not-this-apps-password';
    expect(await postgresLogin(ours.href)).toBe('refused');
  });
});
