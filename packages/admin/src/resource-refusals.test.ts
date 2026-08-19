// Every way `adminResource()` refuses rather than guessing, and the fix line each refusal carries.
// `resource.test.ts` owns the derivations; this file owns the five throws, because a derivation
// that silently narrows is the failure mode the admin cannot afford: a resource the dashboard
// half-renders is a screen an operator trusts.

import { describe, expect, test } from 'bun:test';
import type { AdminColumnMeta, AdminEntity } from './registry';
import { adminResource, repoOf, resourceFor } from './resource';

const meta = (over: Partial<AdminColumnMeta> = {}): { $meta: AdminColumnMeta } => ({
  $meta: { kind: 'text', notNull: true, primaryKey: false, unique: false, index: false, ...over },
});

/** A structural `AdminEntity` — the surface `registry.ts` declares and `tsc` pins a real
 * `entity()` against. Hand-built because `entity()` cannot produce these shapes at all, which is
 * the point: the admin still has to answer for what a JSON-at-the-boundary registry hands it. */
const shaped = (
  over: Partial<AdminEntity> & Pick<AdminEntity, '$name' | '$primaryKey' | '$columns'>,
): AdminEntity => ({
  $schema: undefined,
  $describe: () => ({ columns: [] }),
  ...over,
});

const thrown = (run: () => unknown): { code?: string; cause?: string; fix?: string } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; cause?: string; fix?: string };
  }
  throw new Error('expected a refusal, and nothing was thrown');
};

describe('an entity the admin cannot address a row of', () => {
  test('no primary key and no id column is refused, naming the entity and a runnable fix', () => {
    const seen = thrown(() =>
      adminResource(
        shaped({
          $name: 'admin_refuse_keyless',
          $primaryKey: [],
          $columns: { slug: meta(), title: meta() },
        }),
      ),
    );
    expect(seen.code).toBe('X_ADMIN_ENTITY_UNKNOWN');
    expect(seen.cause).toContain('no primary key');
    expect(seen.cause).toContain('admin_refuse_keyless');
    // A runnable command, not prose. NOTE: the `known` column list this call site computes is
    // dropped — `AdminEntityUnknownError` only renders it when no `cause` is supplied, which is
    // the `resourceFor` path below.
    expect(seen.fix).toContain('x g entity admin_refuse_keyless');
  });

  test('a column literally called "id" is accepted as the key even with no primaryKey flag', () => {
    const resource = adminResource(
      shaped({
        $name: 'admin_refuse_implicit_id',
        $primaryKey: [],
        $columns: { id: meta({ kind: 'uuid' }), title: meta() },
      }),
    );
    expect(resource.idField).toBe('id');
  });

  test('an entity with no columns at all is refused before any field is derived', () => {
    const seen = thrown(() =>
      adminResource(shaped({ $name: 'admin_refuse_empty', $primaryKey: ['id'], $columns: {} })),
    );
    expect(seen.code).toBe('X_ADMIN_ENTITY_UNKNOWN');
    expect(seen.cause).toContain('declares no columns');
  });
});

describe('an action with no policy is refused at derive time', () => {
  const withActions = (): AdminEntity =>
    shaped({
      $name: 'admin_refuse_action',
      $primaryKey: ['id'],
      $columns: { id: meta({ kind: 'uuid', primaryKey: true }), title: meta() },
    });

  const publish = (
    permission: unknown,
  ): { name: string; permission: string; handle: () => Promise<unknown> } => ({
    name: 'post.publish',
    permission: permission as string,
    handle: async (): Promise<unknown> => ({}),
  });

  test('an absent permission is X_ADMIN_POLICY_MISSING, naming the action', () => {
    const seen = thrown(() =>
      adminResource(withActions(), { actions: [publish(undefined)] as never }),
    );
    expect(seen.code).toBe('X_ADMIN_POLICY_MISSING');
    expect(JSON.stringify(seen)).toContain('post.publish');
  });

  test('a blank-but-present permission is refused too — whitespace is not a policy', () => {
    const seen = thrown(() => adminResource(withActions(), { actions: [publish('   ')] as never }));
    expect(seen.code).toBe('X_ADMIN_POLICY_MISSING');
  });

  test('a real permission derives normally', () => {
    const resource = adminResource(withActions(), {
      actions: [publish('post:publish')] as never,
    });
    expect(resource.actions).toHaveLength(1);
  });
});

describe('resource.field() and repoOf() name what is missing', () => {
  const resource = adminResource(
    shaped({
      $name: 'admin_refuse_lookup',
      $primaryKey: ['id'],
      $columns: { id: meta({ kind: 'uuid', primaryKey: true }), title: meta() },
    }),
    { fields: { title: { hidden: false } } },
  );

  test('a name that is not a field says so, with the command that lists them', () => {
    const seen = thrown(() => resource.field('nope'));
    expect(seen.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
    expect(seen.cause).toContain('hidden, or not a column');
    expect(seen.fix).toContain('x manifest');
    expect(seen.fix).toContain('admin_refuse_lookup');
  });

  test('a HIDDEN field is a miss too — hiding it removes it from every surface', () => {
    const hidden = adminResource(
      shaped({
        $name: 'admin_refuse_hidden',
        $primaryKey: ['id'],
        $columns: { id: meta({ kind: 'uuid', primaryKey: true }), secret: meta() },
      }),
      { fields: { secret: { hidden: true } } },
    );
    expect(hidden.fields.map((field) => field.name)).toEqual(['id']);
    expect(thrown(() => hidden.field('secret')).code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
  });

  test('a resource with no repo bound cannot read or write, and says which resource', () => {
    const seen = thrown(() => repoOf(resource));
    expect(seen.code).toBe('X_ADMIN_ENTITY_UNKNOWN');
    expect(seen.cause).toContain('admin_refuse_lookup');
    expect(seen.cause).toContain('no repo bound');
  });

  test('a bound repo is handed straight back', () => {
    const repo = {
      list: async (): Promise<readonly Record<string, unknown>[]> => [],
      find: async (): Promise<Record<string, unknown> | null> => null,
      create: async (input: Record<string, unknown>): Promise<Record<string, unknown>> => input,
      update: async (
        _id: string,
        patch: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => patch,
      destroy: async (): Promise<void> => undefined,
    };
    const bound = adminResource(
      shaped({
        $name: 'admin_refuse_bound',
        $primaryKey: ['id'],
        $columns: { id: meta({ kind: 'uuid', primaryKey: true }) },
      }),
      { repo },
    );
    expect(repoOf(bound)).toBe(repo);
  });
});

describe('resourceFor', () => {
  const resource = adminResource(
    shaped({
      $name: 'admin_refuse_named',
      $primaryKey: ['id'],
      $columns: { id: meta({ kind: 'uuid', primaryKey: true }) },
    }),
  );

  test('a known name comes back', () => {
    expect(resourceFor([resource], 'admin_refuse_named')).toBe(resource);
  });

  test('an unknown one lists the names that would have worked', () => {
    const seen = thrown(() => resourceFor([resource], 'ghost'));
    expect(seen.code).toBe('X_ADMIN_ENTITY_UNKNOWN');
    expect(JSON.stringify(seen)).toContain('admin_refuse_named');
  });
});
