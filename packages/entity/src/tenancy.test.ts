import { afterAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor, withChildContext } from '@ultimat3/core';
import { text, uuid } from './columns';
import { entity } from './entity';
import type { EntityError } from './errors';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';
import {
  assertScoped,
  describePlan,
  emptyPlan,
  hasOrgPredicate,
  isOrgScoped,
  orgScoped,
  type QueryPlan,
  scopedPlan,
  tenantColumnOf,
} from './tenancy';

/** The plan a request would have built, so a derivation can be read rather than inferred. */
const asPlan = (build: () => QueryPlan): QueryPlan =>
  runWithContext(
    createContext({
      actor: userActor({ id: 'u-1', orgId: '11111111-1111-4111-8111-111111111111' }),
    }),
    build,
  );

const posts = entity('tenancy_test_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text() },
});

const settings = entity('tenancy_test_settings', {
  columns: { id: uuid().primaryKey(), key: text() },
});

/**
 * The thrown error, or `undefined` — the same helper `plan.test.ts` and five siblings define. A
 * sentinel `throw new Error('expected a throw')` would be a bare `Error` in a repo that has none,
 * and it fails on an absent `cause` rather than on the code that was supposed to be raised.
 */
const caught = (run: () => unknown): EntityError | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as EntityError;
  }
};

afterAll(() => {
  clearRegistry();
});

describe('detection', () => {
  test('a tenant column is what makes an entity tenant-scoped', () => {
    expect(isOrgScoped(posts.$columns)).toBe(true);
    expect(isOrgScoped(settings.$columns)).toBe(false);
    expect(tenantColumnOf(posts.$columns)).toBe('orgId');
  });

  test('a column named orgId counts even without .tenant()', () => {
    const comments = entity('tenancy_test_comments', {
      columns: { id: uuid().primaryKey(), orgId: uuid() },
    });
    expect(comments.$tenantColumn).toBe('orgId');
  });

  test('neither a tenant column nor an orgId column leaves the entity unscoped', () => {
    expect(settings.$tenantColumn).toBeNull();
    expect(settings.$describe().orgScoped).toBe(false);
  });
});

describe('an explicitly declared tenant', () => {
  test('names the column itself, and beats both inference rules', () => {
    const docs = entity('tenancy_test_docs', {
      tenant: 'workspaceId',
      columns: {
        id: uuid().primaryKey(),
        // Neither marked nor conventionally named — the declaration is the whole switch.
        workspaceId: uuid(),
        orgId: uuid(),
        title: text(),
      },
    });
    expect(docs.$tenantColumn).toBe('workspaceId');
    expect(docs.$describe().orgScoped).toBe(true);
    expect(tenantColumnOf(docs.$columns)).toBe('orgId');
  });

  test('naming a column that does not exist is a declaration error', () => {
    // `tsc` already refuses the key; the cast is what a JS caller or a renamed column looks like.
    const withRenamedColumn = () =>
      entity('tenancy_test_broken', {
        tenant: 'notAColumn' as 'id',
        columns: { id: uuid().primaryKey(), workspaceId: uuid() },
      });
    const error = caught(withRenamedColumn);
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    // The cause lists the columns, so the fix is readable without opening the file.
    expect(String(error?.cause)).toContain('workspaceId');
  });
});

describe('assertScoped', () => {
  test('throws X_TENANCY_UNSCOPED for a scoped entity queried without an org', () => {
    expect(() => assertScoped('post', 'orgId', 'findMany', emptyPlan('post'))).toThrow(
      /X_TENANCY_UNSCOPED|org predicate/,
    );
  });

  test('the fix line names the call that has to change', () => {
    const error = caught(() => assertScoped('post', 'orgId', 'findMany', emptyPlan('post')));
    expect(error).toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(String(error?.fix)).toContain('orgScoped(');
  });

  test('passes once the org predicate is present', () => {
    const plan = orgScoped(emptyPlan('post'), 'org-1');
    expect(hasOrgPredicate(plan)).toBe(true);
    expect(() => assertScoped('post', 'orgId', 'findMany', plan)).not.toThrow();
  });

  test('an unscoped entity is never forced to carry an org', () => {
    expect(() => assertScoped('setting', null, 'findMany', emptyPlan('setting'))).not.toThrow();
  });
});

describe('orgScoped', () => {
  test('adds the predicate exactly once', () => {
    const twice = orgScoped(orgScoped(emptyPlan('post'), 'org-1'), 'org-1');
    expect(twice.where).toHaveLength(1);
    expect(twice.where[0]).toEqual({ column: 'orgId', op: 'eq', value: 'org-1' });
  });

  test('a plan is safe to log: values are elided', () => {
    const rendered = describePlan(orgScoped(emptyPlan('post'), 'secret-org'));
    expect(rendered).toContain('where orgId eq ?');
    expect(rendered).not.toContain('secret-org');
  });
});

// The defect, as a specification: the tenant a query runs under is the ACTOR's, and a value the
// caller supplied is at best a restatement of it — never a way to name a different one.
describe('the tenant comes from the actor, never from the caller', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const rows = [
    { id: '33333333-3333-4333-8333-333333333333', orgId: ORG_A, title: 'ours' },
    { id: '44444444-4444-4444-8444-444444444444', orgId: ORG_B, title: 'theirs' },
  ];
  const asOrgA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: userActor({ id: 'u-1', orgId: ORG_A }) }), fn);

  test('no row of another tenant is ever returned, whatever the caller names', async () => {
    const repo = memoryRepo(posts, rows);
    // The blessed idiom: `orgId` is an action input, so the value is the caller's and the handler
    // passes it straight down. Refusing or answering empty are both fine — a row is not.
    const read = await asOrgA(() =>
      repo.findMany({ orgId: ORG_B }).then(
        (page) => page.rows,
        () => [],
      ),
    );
    expect(read).toEqual([]);
  });

  test('a caller-supplied org that is not the actor’s is refused, never silently overridden', async () => {
    const repo = memoryRepo(posts, rows);
    await asOrgA(async () => {
      await expect(repo.findMany({ orgId: ORG_B })).rejects.toBeUltimateError(
        'X_TENANCY_ACTOR_MISMATCH',
      );
    });
  });
});

describe('the tenant a plan actually runs under', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const rows = [
    { id: '55555555-5555-4555-8555-555555555555', orgId: ORG_A, title: 'ours' },
    { id: '66666666-6666-4666-8666-666666666666', orgId: ORG_B, title: 'theirs' },
  ];
  const asOrgA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: userActor({ id: 'u-1', orgId: ORG_A }) }), fn);

  test('is derived, so a call that names no tenant reads the actor’s and only the actor’s', async () => {
    const repo = memoryRepo(posts, rows);
    const page = await asOrgA(() => repo.findMany({}));
    expect(page.rows.map((row) => row.title)).toEqual(['ours']);
  });

  test('the derived predicate is in the plan, not applied after the rows are in', () => {
    const plan = asPlan(() => scopedPlan('post', 'orgId', 'findMany', emptyPlan('post')));
    expect(plan.where).toEqual([{ column: 'orgId', op: 'eq', value: ORG_A }]);
  });

  test('a caller-supplied org equal to the actor’s is a restatement, not a second predicate', () => {
    const named = orgScoped(emptyPlan('post'), ORG_A);
    const plan = asPlan(() => scopedPlan('post', 'orgId', 'findMany', named));
    expect(plan.where).toHaveLength(1);
  });

  test('a set that merely contains the actor’s org is refused too', () => {
    const both = {
      ...emptyPlan('post'),
      where: [{ column: 'orgId', op: 'in' as const, value: [ORG_A, ORG_B] }],
    };
    expect(() => asPlan(() => scopedPlan('post', 'orgId', 'findMany', both))).toThrow(
      /X_TENANCY_ACTOR_MISMATCH/,
    );
  });

  test('the mismatch names both tenants, so a reader can tell an attack from a typo', () => {
    const error = caught(() =>
      asPlan(() => scopedPlan('post', 'orgId', 'findMany', orgScoped(emptyPlan('post'), ORG_B))),
    );
    expect(error).toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');
    expect(String(error?.cause)).toContain(ORG_A);
    expect(String(error?.cause)).toContain(ORG_B);
  });

  test('the fix a mismatch prints is runnable, whatever the predicate held', () => {
    // A cause may describe any value; a fix has to parse. `in` and `is-null` both reach the same
    // refusal, and neither `orgId: ["a","b"]` nor `orgId: undefined` is an org anybody can act as.
    const set = {
      ...emptyPlan('post'),
      where: [{ column: 'orgId', op: 'in' as const, value: [ORG_A, ORG_B] }],
    };
    const absent = {
      ...emptyPlan('post'),
      where: [{ column: 'orgId', op: 'is-null' as const }],
    };
    for (const plan of [set, absent]) {
      const fix = String(
        caught(() => asPlan(() => scopedPlan('post', 'orgId', 'find', plan)))?.fix,
      );
      expect(fix).toContain("orgId: '<org>'");
      expect(fix).not.toContain('orgId: undefined');
      expect(fix).not.toContain('orgId: [');
    }
  });

  test('an unscoped plan says which of the two situations it is', () => {
    // `assertScoped` verifies a plan it did not build, so it is the one path that can refuse an
    // unscoped plan while an actor IS carrying a tenant — and it must not claim there was none.
    const withActor = caught(() =>
      asPlan(() => {
        assertScoped('post', 'orgId', 'findMany', emptyPlan('post'));
      }),
    );
    expect(withActor).toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(String(withActor?.cause)).toContain(ORG_A);
    expect(String(withActor?.fix)).toContain('scopedPlan(');

    const noContext = caught(() => assertScoped('post', 'orgId', 'findMany', emptyPlan('post')));
    expect(noContext).toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(String(noContext?.cause)).toContain('no request context');
    expect(String(noContext?.fix)).toContain('runWithContext(');
  });

  test('an actor carrying no tenant is refused, never handed the tenant it asked for', async () => {
    // The decision, pinned: an actor with no org is inside no org, so every tenant-scoped row is
    // somebody else's. Anonymous and system callers say so explicitly with crossTenant().
    const repo = memoryRepo(posts, rows);
    await runWithContext(createContext(), async () => {
      await expect(repo.findMany({ orgId: ORG_B })).rejects.toBeUltimateError(
        'X_TENANCY_ACTOR_ORG_REQUIRED',
      );
      await expect(repo.findMany({})).rejects.toBeUltimateError('X_TENANCY_ACTOR_ORG_REQUIRED');
    });
  });

  test('an entity with no tenant column is untouched by any of it', async () => {
    const repo = memoryRepo(settings, [{ id: '77777777-7777-4777-8777-777777777777', key: 'k' }]);
    await runWithContext(createContext(), async () => {
      expect((await repo.findMany({})).rows).toHaveLength(1);
    });
  });

  test('impersonation re-derives: the tenant is whoever is acting now', async () => {
    const repo = memoryRepo(posts, rows);
    const titles = await asOrgA(() =>
      withChildContext({ actor: userActor({ id: 'u-2', orgId: ORG_B }) }, async () =>
        (await repo.findMany({})).rows.map((row) => row.title),
      ),
    );
    expect(titles).toEqual(['theirs']);
  });

  test('writes are addressed under the same tenant as reads', async () => {
    const repo = memoryRepo(posts, rows);
    await asOrgA(async () => {
      // Another tenant's id is a row that does not exist, exactly as it is for a read.
      await expect(repo.update(rows[1]?.id ?? '', { title: 'x' })).rejects.toBeUltimateError(
        'X_NOT_FOUND',
      );
      await expect(repo.deleteWhere({ orgId: ORG_B })).rejects.toBeUltimateError(
        'X_TENANCY_ACTOR_MISMATCH',
      );
    });
  });

  test('outside every request there is no actor, so the caller still names the tenant', async () => {
    const repo = memoryRepo(posts, rows);
    // A script, a boot path or a test harness — no identity to check a value against, and the
    // refusal for naming nothing is the one this package always had.
    expect((await repo.findMany({ orgId: ORG_B })).rows.map((row) => row.title)).toEqual([
      'theirs',
    ]);
    await expect(repo.findMany({})).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
  });
});

// The write half of the same rule: a row carries its tenant as a value, and a value the caller
// chose is exactly as untrustworthy in a row as it is in a predicate.
describe('the tenant a row is written under', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const MINE = '88888888-8888-4888-8888-888888888888';
  const seeded = [{ id: MINE, orgId: ORG_A, title: 'ours' }];
  const asOrgA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: userActor({ id: 'u-1', orgId: ORG_A }) }), fn);

  test('an insert into another tenant is refused, and stores nothing', async () => {
    const repo = memoryRepo(posts, []);
    await asOrgA(async () => {
      await expect(
        repo.insert({ id: '99999999-9999-4999-8999-999999999999', orgId: ORG_B, title: 'theirs' }),
      ).rejects.toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');
    });
    // Refused before the row lands, not after: a guard that threw on the way out would leave the
    // row in the table and the caller believing it failed.
    expect(await repo.findMany({ orgId: ORG_B })).toEqual({ rows: [], nextCursor: null });
  });

  test('a patch cannot move a row this tenant owns into another one', async () => {
    const repo = memoryRepo(posts, seeded);
    await asOrgA(async () => {
      await expect(repo.update(MINE, { orgId: ORG_B })).rejects.toBeUltimateError(
        'X_TENANCY_ACTOR_MISMATCH',
      );
      await expect(repo.updateWhere({ id: MINE }, { orgId: ORG_B })).rejects.toBeUltimateError(
        'X_TENANCY_ACTOR_MISMATCH',
      );
    });
    expect((await repo.findMany({ orgId: ORG_A })).rows).toHaveLength(1);
  });
});
