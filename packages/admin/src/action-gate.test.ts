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
