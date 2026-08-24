import { afterAll, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import {
  anonymousActor,
  createContext,
  runWithContext,
  serviceActor,
  userActor,
  withChildContext,
} from '@ultimat3/core';
import { text, uuid } from './columns';
import { CROSS_TENANT_SCOPE, crossTenant, crossTenantReason } from './cross-tenant';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';

const posts = entity('cross_tenant_test_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text() },
});

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const rows = [
  { id: '33333333-3333-4333-8333-333333333333', orgId: ORG_A, title: 'ours' },
  { id: '44444444-4444-4444-8444-444444444444', orgId: ORG_B, title: 'theirs' },
];

const support = serviceActor({ id: 'support-1', scopes: [CROSS_TENANT_SCOPE] });
const member = userActor({ id: 'u-1', orgId: ORG_A });

const inRequest = <T>(actor: Actor, work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor }), work);

afterAll(() => {
  clearRegistry();
});

describe('the capability', () => {
  test('an actor without the scope cannot open the escape hatch', async () => {
    await inRequest(member, async () => {
      const denied = () => crossTenant('a support tool reads every org', () => null);
      expect(denied).toThrow(/X_TENANCY_CROSS_DENIED/);
      try {
        denied();
      } catch (error) {
        // The cause names who was refused and the fix names what to grant — an operator can act on
        // it without reading this file.
        expect(String((error as { cause?: string }).cause)).toContain('user:u-1@');
        expect(String((error as { fix?: string }).fix)).toContain(CROSS_TENANT_SCOPE);
      }
    });
  });

  test('outside every request context there is no actor to prove it, so it is refused too', () => {
    expect(() => crossTenant('a nightly script sweeps every org', () => null)).toThrow(
      /X_TENANCY_CROSS_DENIED/,
    );
  });

  test('an anonymous actor is refused like any other actor without the scope', async () => {
    await inRequest(anonymousActor(), async () => {
      expect(() => crossTenant('why', () => null)).toThrow(/X_TENANCY_CROSS_DENIED/);
    });
  });

  test('a blank reason is refused before the capability is even read', async () => {
    await inRequest(support, async () => {
      expect(() => crossTenant('   ', () => null)).toThrow(/X_INVARIANT/);
    });
  });
});

describe('the scope', () => {
  test('reads every tenant while it is open, and nothing outside it', async () => {
    const repo = memoryRepo(posts, rows);
    const titles = await inRequest(support, () =>
      crossTenant('a support tool reads every org', async () => {
        const page = await repo.findMany({});
        return page.rows.map((row) => row.title);
      }),
    );
    expect(titles.toSorted()).toEqual(['ours', 'theirs']);
  });

  test('closes when it returns: the next read is guarded again', async () => {
    const repo = memoryRepo(posts, rows);
    await inRequest(support, async () => {
      await crossTenant('a support tool reads every org', () => repo.findMany({}));
      // `support` carries the capability and no tenant of its own, which is exactly the actor the
      // guard refuses once the scope is closed.
      await expect(repo.findMany({})).rejects.toBeUltimateError('X_TENANCY_ACTOR_ORG_REQUIRED');
    });
  });

  test('an impersonated actor inside it does not inherit the capability', async () => {
    const repo = memoryRepo(posts, rows);
    await inRequest(support, () =>
      crossTenant('a support tool reads every org', async () => {
        // The scope is still open, but the actor issuing this read is the impersonated member —
        // proving the capability once at the top would hand it their entire tenant space.
        await withChildContext({ actor: member }, async () => {
          await expect(repo.findMany({})).rejects.toBeUltimateError('X_TENANCY_CROSS_DENIED');
        });
      }),
    );
  });

  test('the reason is readable, innermost first, and absent outside', async () => {
    expect(crossTenantReason()).toBeUndefined();
    await inRequest(support, () =>
      crossTenant('outer', async () => {
        expect(crossTenantReason()).toBe('outer');
        crossTenant('inner', () => {
          expect(crossTenantReason()).toBe('inner');
        });
        // It survives an await, which a module-scope flag could not do without leaking into
        // whichever request ran next.
        await Promise.resolve();
        expect(crossTenantReason()).toBe('outer');
      }),
    );
    expect(crossTenantReason()).toBeUndefined();
  });
});
