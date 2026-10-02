// The action bar: the one place where "what renders" and "what runs" have to be the same
// decision. A button on screen is a call `invokeAdminAction` would allow, and a denied action has
// no button at all — never a disabled one, which tells an operator the action exists. Asserted on
// the MARKUP the framework's own server renderer emits, because the contract is the form a
// browser submits: an admin screen never hydrates, so a control is a native POST or it is nothing.
//
// The authz here RECORDS every query it is asked, so the assertions are about what the decision
// path was handed (permission, actor, subject) and not only about the verdict it returned.

import { describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  allowed,
  denied,
} from './authz';
import type { AdminAction } from './registry';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically —
// a plugin only transforms modules loaded after it.
const { renderComponent } = await import('@ultimat3/render/server');
const { ACTION_OPERATION, AdminActions, OPERATION_FIELD } = await import('./actions');

registerCatalog('en', {
  'admin.action.post.publish': 'Publish (probe)',
  'admin.action.post.purge': 'Purge (probe)',
  'admin.actions.label': 'Actions (probe)',
  // The placeholder matters: a missing key renders `⟦key⟧` and swallows every interpolation, so
  // an assertion about the token would pass against a catalog gap.
  'admin.actions.confirm.body': 'Type {token} to confirm',
});

const ACTOR: AdminActor = { id: 'u_1', roles: ['editor'], orgId: 'org_1' };

const publish: AdminAction = {
  name: 'post.publish',
  permission: 'post:publish',
  entity: 'post',
  handle: async (): Promise<unknown> => ({ ok: true }),
};

const purge: AdminAction = {
  name: 'post.purge',
  permission: 'post:purge',
  entity: 'post',
  destructive: true,
  handle: async (): Promise<unknown> => ({ ok: true }),
};

/** An authz that answers from an explicit set AND keeps every question it was asked. */
function recordingAuthz(grant: ReadonlySet<string>): AdminAuthz & {
  readonly asked: AdminAuthzQuery[];
} {
  const asked: AdminAuthzQuery[] = [];
  return {
    asked,
    decide(query): AdminDecision {
      asked.push(query);
      return grant.has(query.permission)
        ? allowed(query.permission, 'probe.granted')
        : denied(query.permission, 'probe.refused');
    },
  };
}

const EDITOR = new Set(['admin:write', 'post:publish']);
const DESTROYER = new Set(['admin:write', 'admin:destroy', 'post:publish', 'post:purge']);

const HREF = '/admin/posts/p_1';

/** The bar as the browser receives it. */
const render = (
  authz: AdminAuthz,
  over: Record<string, unknown> = {},
  actions: readonly AdminAction[] = [publish, purge],
): Promise<string> =>
  renderComponent(
    () =>
      AdminActions({
        actions,
        actor: ACTOR,
        authz,
        subject: { entity: 'post', id: 'p_1' },
        href: HREF,
        ...over,
      }),
    {},
    'apps/admin/app/admin/page.tsx',
  );

/** Each `<form>…</form>` of the bar, in order. */
const forms = (html: string): readonly string[] => html.match(/<form[\s\S]*?<\/form>/g) ?? [];

describe('a denied action has no button, ever', () => {
  test('only the permitted action renders, and the refused one leaves no trace', async () => {
    const html = await render(recordingAuthz(EDITOR));
    expect(html).toContain('Publish (probe)');
    expect(html).not.toContain('Purge (probe)');
    // Not even the name: a disabled button is an enumeration oracle for the action list.
    expect(html).not.toContain('post.purge');
    expect(forms(html)).toHaveLength(1);
  });

  test('the decision path is asked for the admin-level gate BEFORE the action permission', async () => {
    const authz = recordingAuthz(DESTROYER);
    await render(authz);
    // `permissionsForAction` — the coarse admin gate first, the action's own policy second, and
    // `admin:destroy` for a destructive action rather than `admin:write`.
    expect(authz.asked.map((query) => query.permission)).toEqual([
      'admin:write',
      'post:publish',
      'admin:destroy',
      'post:purge',
    ]);
  });

  test('the actor and the row subject reach the authz, not just the permission name', async () => {
    const authz = recordingAuthz(EDITOR);
    await render(authz);
    for (const query of authz.asked) {
      expect(query.actor).toEqual(ACTOR);
      expect(query.subject).toEqual({ entity: 'post', id: 'p_1' });
    }
  });

  test('an actor who may run nothing gets an empty marker, never an empty form', async () => {
    const html = await render(recordingAuthz(new Set()));
    expect(html).toBe('<span class="x-admin-actions-empty"></span>');
  });
});

describe('a button is a native form submit', () => {
  test("one form per action, posting at the SUBJECT's URL, naming the action", async () => {
    const [form = ''] = forms(await render(recordingAuthz(EDITOR)));
    // `method="post"` and `type="submit"`: a `type="button"` on a page that never hydrates is
    // markup that can never do anything, which is what this bar was.
    expect(form).toContain(`method="post" action="${HREF}"`);
    expect(form).toContain('type="submit"');
    expect(form).not.toContain('type="button"');
    expect(form).toContain(`name="${OPERATION_FIELD}" value="${ACTION_OPERATION}"`);
    expect(form).toContain('name="name" value="post.publish"');
  });

  test('the row id is NOT a hidden field — the URL is the subject, and a stale page cannot forge it', async () => {
    expect(await render(recordingAuthz(DESTROYER))).not.toContain('name="id"');
  });

  test('a safe action asks for no confirmation', async () => {
    const [form = ''] = forms(await render(recordingAuthz(EDITOR)));
    expect(form).not.toContain('name="confirmation"');
  });
});

describe('a destructive action re-confirms, in the same form', () => {
  test('the token is on screen and the echo is a REQUIRED input, never pre-filled', async () => {
    const [, purgeForm = ''] = forms(await render(recordingAuthz(DESTROYER)));
    expect(purgeForm).toContain('name="name" value="post.purge"');
    expect(purgeForm).toContain('Type post:p_1 to confirm');
    const [echo = ''] = /<input[^>]*name="confirmation"[^>]*>/.exec(purgeForm) ?? [];
    expect(echo).toContain('required');
    // Typed, not handed over: a prefilled echo is a confirmation nobody made.
    expect(echo).not.toContain('value="post:p_1"');
  });

  test('a global action confirms against "admin:" rather than against "undefined:undefined"', async () => {
    const html = await render(recordingAuthz(DESTROYER), { subject: undefined, href: '/admin' });
    expect(html).toContain('Type admin: to confirm');
    expect(html).not.toContain('undefined');
    expect(html).toContain('action="/admin"');
  });
});

describe('the label key', () => {
  test('an action with no labelKey is labelled admin.action.<name>', async () => {
    expect(await render(recordingAuthz(EDITOR))).toContain('Publish (probe)');
  });

  test('a declared labelKey wins over the derived one', async () => {
    const relabelled: AdminAction = { ...publish, labelKey: 'admin.action.post.purge' };
    const html = await render(recordingAuthz(EDITOR), {}, [relabelled]);
    expect(html).toContain('Purge (probe)');
    expect(html).not.toContain('Publish (probe)');
  });
});
