// RUNS the PIN recipe on `wiki/Building-Your-Own-Base.md`: the right PIN mints the operator's
// session capped at the device's, a wrong PIN and an unknown operator are one refusal, and the
// attempt that fills the window locks that operator on that device — and only there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Auth,
  type AuthSession,
  defineAuth,
  type IssuedSession,
  memoryAuthAdapter,
} from '@ultimat3/auth';
import { exportsOf, type LoadedRecipe, loadRecipe } from '../lib/base-recipes';
import { repoRoot } from '../lib/run';

interface OperatorRow {
  readonly userId: string;
  readonly pinHash: string;
}

interface PinRecipe {
  enrolPin(pin: string): Promise<string>;
  switchOperator(
    auth: Auth,
    input: {
      operatorId: string;
      pin: string;
      operator: OperatorRow | null;
      device: Pick<AuthSession, 'userId' | 'absoluteExpiresAt'>;
    },
  ): Promise<{ readonly issued: IssuedSession; readonly cookie: string }>;
}

const MAX_ATTEMPTS = 3;

let loaded: LoadedRecipe;
let recipe: PinRecipe;
let auth: Auth;
let operator: OperatorRow;

beforeAll(async () => {
  loaded = await loadRecipe(repoRoot(), 'apps/web/shared/base/operator-pin.ts');
  recipe = exportsOf<PinRecipe>(loaded, ['enrolPin', 'switchOperator']);
  auth = defineAuth({ adapter: memoryAuthAdapter(), rateLimit: { maxAttempts: MAX_ATTEMPTS } });
  operator = { userId: 'user_op_7', pinHash: await recipe.enrolPin('4821') };
});

afterAll(async () => {
  await loaded.dispose();
});

const deviceExpiry = (): Date => new Date(Date.now() + 60 * 60 * 1000);

const attempt = (pin: string, deviceUserId: string, row: OperatorRow | null = operator) =>
  recipe.switchOperator(auth, {
    operatorId: 'op_7',
    pin,
    operator: row,
    device: { userId: deviceUserId, absoluteExpiresAt: deviceExpiry() },
  });

const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (thrown) {
    return (thrown as { code?: unknown }).code;
  }
  return expect.unreachable('expected a refusal');
};

describe('recipe · a PIN for a shared device', () => {
  test('the right PIN is the operator’s session, capped at the device’s, and its cookie', async () => {
    const device = deviceExpiry();
    const { issued, cookie } = await recipe.switchOperator(auth, {
      operatorId: 'op_7',
      pin: '4821',
      operator,
      device: { userId: 'till_1', absoluteExpiresAt: device },
    });
    expect(issued.session.userId).toBe('user_op_7');
    expect(issued.session.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(device.getTime());
    expect(cookie.startsWith(`${auth.sessions.policy.cookieName}=`)).toBe(true);
  });

  test('a wrong PIN and an unknown operator are the same refusal', async () => {
    expect(await codeOf(() => attempt('0000', 'till_2'))).toBe('X_UNAUTHENTICATED');
    expect(await codeOf(() => attempt('4821', 'till_2', null))).toBe('X_UNAUTHENTICATED');
  });

  test('the attempt that fills the window locks the pair, the right PIN included', async () => {
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      expect(await codeOf(() => attempt('1111', 'till_3'))).toBe('X_UNAUTHENTICATED');
    }
    expect(await codeOf(() => attempt('4821', 'till_3'))).toBe('X_ACCOUNT_LOCKED');
    // Another device is another key: one locked till does not lock the operator everywhere.
    expect((await attempt('4821', 'till_4')).issued.session.userId).toBe('user_op_7');
  });
});
