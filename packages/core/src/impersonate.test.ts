import { describe, expect, test } from 'bun:test';
import { actorLabel, serviceActor, userActor } from './actor';
import { createContext, runWithContext, useContext } from './context';
import { isUltimateError } from './errors';
import { impersonate, impersonationReason, isImpersonating } from './impersonate';
import { createLogger } from './logger';

const support = serviceActor({ id: 'eng-7' });
const customer = userActor({ id: 'cust-99', orgId: 'org-3' });

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (thrown) {
    return isUltimateError(thrown) ? thrown.code : 'not-ultimate';
  }
  return 'no-throw';
};

const inRequest = <T>(fn: () => T): T =>
  runWithContext(createContext({ actor: support, logger: createLogger({ level: 'silent' }) }), fn);

describe('impersonate', () => {
  test('refuses a blank reason — an escape with no argument is a pragma', () => {
    expect(codeOf(() => inRequest(() => impersonate(customer, '   ', () => 1)))).toBe(
      'X_INVARIANT',
    );
  });

  test('refuses outside a request — there is no original actor to preserve', () => {
    expect(codeOf(() => impersonate(customer, 'ticket 4821', () => 1))).toBe('X_NO_CONTEXT');
  });

  test('the audit trail names the support engineer, not the customer', () => {
    const label = inRequest(() =>
      impersonate(customer, 'ticket 4821: reproduce the failed refund', () =>
        actorLabel(useContext().actor),
      ),
    );
    expect(label).toBe('service:eng-7→user:cust-99@org-3');
  });

  test('the effective actor is still the customer, so authz answers as them', () => {
    const seen = inRequest(() =>
      impersonate(customer, 'ticket 4821', () => {
        const { actor } = useContext();
        return { id: actor.id, kind: actor.kind, origin: actor.onBehalfOf };
      }),
    );
    expect(seen).toEqual({
      id: 'cust-99',
      kind: 'user',
      origin: { actorId: 'eng-7', actorKind: 'service' },
    });
  });

  test('the reason is readable inside the scope and gone outside it', () => {
    const inside = inRequest(() =>
      impersonate(customer, 'ticket 4821', () => impersonationReason()),
    );
    expect(inside).toBe('ticket 4821');
    expect(impersonationReason()).toBeUndefined();
    expect(inRequest(() => isImpersonating())).toBe(false);
  });

  test('survives an await — the reason is async-scoped, not a global', async () => {
    const seen = await inRequest(() =>
      impersonate(customer, 'ticket 4821', async () => {
        await Promise.resolve();
        return impersonationReason();
      }),
    );
    expect(seen).toBe('ticket 4821');
  });

  test('the original actor is not lost when the impersonated actor already had an origin', () => {
    const alreadyStamped = userActor({
      id: 'cust-99',
      onBehalfOf: { actorId: 'someone-else', actorKind: 'user' },
    });
    const origin = inRequest(() =>
      impersonate(alreadyStamped, 'ticket 4821', () => useContext().actor.onBehalfOf),
    );
    expect(origin).toEqual({ actorId: 'eng-7', actorKind: 'service' });
  });
});
