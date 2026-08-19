import { describe, expect, test } from 'bun:test';
import { actionButtons, invokeAdminAction } from './action-gate';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { AdminAction } from './registry';

const publish: AdminAction = {
  name: 'post.publish',
  permission: 'post:publish',
  entity: 'post',
  labelKey: 'admin.action.post.publish',
  async handle(): Promise<{ published: true }> {
    return { published: true };
  },
};

const purge: AdminAction = {
  name: 'post.purge',
  permission: 'post:purge',
  entity: 'post',
  destructive: true,
  async handle(): Promise<{ purged: true }> {
    return { purged: true };
  },
};

const editor: AdminActor = { id: 'u_editor', roles: ['editor'] };
const reader: AdminActor = { id: 'u_reader', roles: ['reader'] };

// One policy, two surfaces. The grant list here stands in for the app's policies; the point
// of the test is that the button and the call read the SAME decision.
const authz = staticAuthz(['admin:write', 'post:publish']);

describe('one policy decides both the button and the call', () => {
  test('an allowed action renders a button and runs', async () => {
    const buttons = actionButtons({ actions: [publish], actor: editor, authz });
    expect(buttons.map((button) => button.name)).toEqual(['post.publish']);

    const result = await invokeAdminAction({
      action: publish,
      input: {},
      actor: editor,
      authz,
      audit: memoryAuditLog(),
      requestId: 'req_1',
    });
    expect(result.ok).toBe(true);
  });

  test('a denied action has no button AND the call is refused', async () => {
    const denyAll = staticAuthz([]);
    const buttons = actionButtons({ actions: [publish], actor: reader, authz: denyAll });
    expect(buttons).toEqual([]);

    const audit = memoryAuditLog();
    const result = await invokeAdminAction({
      action: publish,
      input: {},
      actor: reader,
      authz: denyAll,
      audit,
      requestId: 'req_2',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.decision.allowed).toBe(false);
    // The refusal is on the record: a denial nobody logged is a denial nobody can review.
    expect(audit.entries()[0]?.outcome).toBe('denied');
    expect(audit.entries()[0]?.operation).toBe('post.publish');
  });

  test('the admin-level gate is checked as well as the action policy', () => {
    // Holds post:publish but not admin:write — the admin surface stays shut.
    const partial = staticAuthz(['post:publish']);
    expect(actionButtons({ actions: [publish], actor: editor, authz: partial })).toEqual([]);
  });

  test('a destructive action needs admin:destroy and a confirmation echo', async () => {
    const destroyer = staticAuthz(['admin:destroy', 'post:purge']);
    expect(actionButtons({ actions: [purge], actor: editor, authz }).length).toBe(0);
    expect(actionButtons({ actions: [purge], actor: editor, authz: destroyer }).length).toBe(1);

    const audit = memoryAuditLog();
    const refused = await invokeAdminAction({
      action: purge,
      input: {},
      actor: editor,
      authz: destroyer,
      audit,
      requestId: 'req_3',
      confirmation: 'nope',
      expectedConfirmation: 'post:p_1',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.confirmationRequired).toBe(true);

    const confirmed = await invokeAdminAction({
      action: purge,
      input: {},
      actor: editor,
      authz: destroyer,
      audit,
      requestId: 'req_4',
      confirmation: 'post:p_1',
      expectedConfirmation: 'post:p_1',
    });
    expect(confirmed.ok).toBe(true);
    expect(audit.entries({ limit: 2 }).map((entry) => entry.outcome)).toEqual([
      'allowed',
      'denied',
    ]);
  });
});

describe('a handler that throws is audited as failed, and the throw is not swallowed', () => {
  const boom: AdminAction = {
    name: 'post.explode',
    permission: 'post:publish',
    entity: 'post',
    async handle(): Promise<never> {
      throw new RangeError('the upstream said no');
    },
  };

  const run = async (
    action: AdminAction,
    audit = memoryAuditLog(),
  ): Promise<{ readonly thrown: unknown; readonly audit: ReturnType<typeof memoryAuditLog> }> => {
    let thrown: unknown;
    try {
      await invokeAdminAction({
        action,
        input: {},
        actor: editor,
        authz,
        audit,
        requestId: 'req_boom',
        subject: { entity: 'post', id: 'p_1' },
      });
    } catch (error) {
      thrown = error;
    }
    return { thrown, audit };
  };

  test('the caller gets the ORIGINAL error, not a decision object', async () => {
    const { thrown } = await run(boom);
    // Rethrown untouched: a handler's failure is the app's error, with the app's own stack.
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as Error).message).toBe('the upstream said no');
  });

  test('the failure is logged before the throw escapes — "if it isn’t logged, it didn’t happen"', async () => {
    const { audit } = await run(boom);
    const entries = audit.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    expect(entry.outcome).toBe('failed');
    expect(entry.operation).toBe('post.explode');
    expect(entry.kind).toBe('action');
    expect(entry.entity).toBe('post');
    expect(entry.entityId).toBe('p_1');
    expect(entry.permission).toBe('post:publish');
    // A key, never a sentence — the view renders it.
    expect(entry.reason).toBe('admin.error.action-failed');
    expect(entry.diff).toEqual([]);
  });

  test('a non-Error throw is still audited rather than crashing the audit path', async () => {
    const rude: AdminAction = {
      ...boom,
      name: 'post.rude',
      async handle(): Promise<never> {
        // eslint-disable-next-line no-throw-literal -- the value under test
        throw 'a bare string';
      },
    };
    const { thrown, audit } = await run(rude);
    expect(thrown).toBe('a bare string');
    expect(audit.entries()[0]?.outcome).toBe('failed');
  });

  test('a global action with no entity is audited under "admin", with a null row id', async () => {
    const global: AdminAction = {
      name: 'admin.reindex',
      permission: 'post:publish',
      async handle(): Promise<never> {
        throw new Error('nope');
      },
    };
    const audit = memoryAuditLog();
    await invokeAdminAction({
      action: global,
      input: {},
      actor: editor,
      authz,
      audit,
      requestId: 'req_global',
    }).catch(() => undefined);

    expect(audit.entries()[0]?.entity).toBe('admin');
    expect(audit.entries()[0]?.entityId).toBeNull();
  });
});
