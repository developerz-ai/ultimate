// The action bar: the one place where "what renders" and "what runs" have to be the same
// decision. A button on screen is a call `invokeAdminAction` would allow, and a denied action has
// no button at all — never a disabled one, which tells an operator the action exists.
//
// The authz here RECORDS every query it is asked, so the assertions are about what the decision
// path was handed (permission, actor, subject) and not only about the verdict it returned.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminActionButton } from './action-gate';
import { AdminActions } from './actions';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  allowed,
  denied,
} from './authz';
import {
  byComponent,
  byTag,
  fire,
  installFactory,
  one,
  restoreFactory,
  shallowNodesOf,
} from './inert-jsx';
import type { AdminAction } from './registry';

registerCatalog('en', {
  'admin.action.post.publish': 'Publish (probe)',
  'admin.action.post.purge': 'Purge (probe)',
  'admin.actions.label': 'Actions (probe)',
  // The placeholder matters: a missing key renders `⟦key⟧` and swallows every interpolation, so
  // an assertion about the token would pass against a catalog gap.
  'admin.actions.confirm.body': 'Type {token} to confirm',
});

beforeAll(installFactory);
afterAll(restoreFactory);

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

interface Rendered {
  readonly nodes: ReturnType<typeof shallowNodesOf>;
  readonly ran: (readonly [string, string])[];
  readonly confirmRequested: string[];
  readonly typedInput: string[];
  readonly cancelled: number[];
}

function render(
  authz: AdminAuthz,
  over: Record<string, unknown> = {},
  actions: readonly AdminAction[] = [publish, purge],
): Rendered {
  const ran: [string, string][] = [];
  const confirmRequested: string[] = [];
  const typedInput: string[] = [];
  const cancelled: number[] = [];
  const nodes = shallowNodesOf(
    AdminActions({
      actions,
      actor: ACTOR,
      authz,
      subject: { entity: 'post', id: 'p_1' },
      onRun: (button: AdminActionButton, confirmation: string) =>
        ran.push([button.name, confirmation]),
      onRequestConfirm: (button: AdminActionButton) => confirmRequested.push(button.name),
      onConfirmationInput: (value: string) => typedInput.push(value),
      onCancel: () => cancelled.push(1),
      ...over,
    } as never),
  );
  return { nodes, ran, confirmRequested, typedInput, cancelled };
}

/**
 * The action bar's own buttons. The dialog's submit is the LAST `<button>` in the tree — it is a
 * child of `<Dialog>`, which the shallow walk keeps unexpanded, so ui's close button is not here.
 */
const buttons = (rendered: Rendered): ReturnType<typeof byTag> =>
  byTag(rendered.nodes, 'button').slice(0, -1);

const submit = (rendered: Rendered): ReturnType<typeof byTag>[number] | undefined =>
  byTag(rendered.nodes, 'button').at(-1);

describe('a denied action has no button, ever', () => {
  test('only the permitted action renders, and the refused one leaves no trace', () => {
    const rendered = render(recordingAuthz(EDITOR));
    const labels = buttons(rendered).map((node) => node.props['children']);
    expect(labels).toContain('Publish (probe)');
    expect(labels).not.toContain('Purge (probe)');
    // Not even the name: a disabled button is an enumeration oracle for the action list.
    expect(JSON.stringify(rendered.nodes)).not.toContain('post.purge');
  });

  test('the decision path is asked for the admin-level gate BEFORE the action permission', () => {
    const authz = recordingAuthz(DESTROYER);
    render(authz);
    // `permissionsForAction` — the coarse admin gate first, the action's own policy second, and
    // `admin:destroy` for a destructive action rather than `admin:write`.
    expect(authz.asked.map((query) => query.permission)).toEqual([
      'admin:write',
      'post:publish',
      'admin:destroy',
      'post:purge',
    ]);
  });

  test('the actor and the row subject reach the authz, not just the permission name', () => {
    const authz = recordingAuthz(EDITOR);
    render(authz);
    for (const query of authz.asked) {
      expect(query.actor).toEqual(ACTOR);
      expect(query.subject).toEqual({ entity: 'post', id: 'p_1' });
    }
  });

  test('no permitted action at all renders the empty marker, not an empty toolbar', () => {
    const rendered = render(recordingAuthz(new Set()));
    const marker = one(byTag(rendered.nodes, 'span'), '<span class="x-admin-actions-empty">');
    expect(marker.props['class']).toBe('x-admin-actions-empty');
    expect(byComponent(rendered.nodes, 'Dialog')).toHaveLength(0);
  });
});

describe('pressing a button', () => {
  test('a safe action runs straight away, with no confirmation token', () => {
    const rendered = render(recordingAuthz(EDITOR));
    fire(one(buttons(rendered), 'the publish button'), 'onClick', {});
    expect(rendered.ran).toEqual([['post.publish', '']]);
    expect(rendered.confirmRequested).toEqual([]);
  });

  test('a destructive action asks for confirmation instead of running', () => {
    const rendered = render(recordingAuthz(DESTROYER));
    const purgeButton = buttons(rendered).find(
      (node) => node.props['children'] === 'Purge (probe)',
    );
    expect(purgeButton).toBeDefined();
    if (purgeButton === undefined) return;

    expect(purgeButton.props['data-destructive']).toBe('true');
    fire(purgeButton, 'onClick', {});
    // The whole point: `onRun` is NOT called, so nothing is deleted by one click.
    expect(rendered.ran).toEqual([]);
    expect(rendered.confirmRequested).toEqual(['post.purge']);
  });

  test('a safe action carries no destructive marker for a stylesheet to key off', () => {
    const rendered = render(recordingAuthz(EDITOR));
    expect(one(buttons(rendered), 'the publish button').props['data-destructive']).toBeUndefined();
  });
});

describe('the confirmation dialog is closed until the route says otherwise', () => {
  const pendingPurge: AdminActionButton = {
    name: 'post.purge',
    labelKey: 'admin.action.post.purge',
    destructive: true,
    permission: 'post:purge',
    entity: 'post',
    decision: allowed('post:purge', 'probe.granted'),
  };

  test('no pending action leaves the dialog shut', () => {
    const rendered = render(recordingAuthz(DESTROYER));
    expect(one(byComponent(rendered.nodes, 'Dialog'), '<Dialog>').props['open']).toBe(false);
  });

  test('a pending action opens it and shows the token the operator must type', () => {
    const rendered = render(recordingAuthz(DESTROYER), { pending: pendingPurge });
    const dialog = one(byComponent(rendered.nodes, 'Dialog'), '<Dialog>');
    expect(dialog.props['open']).toBe(true);
    // `confirmationToken(entity, id)` — the record's own id, which an agent cannot guess and an
    // operator has to re-read.
    expect(byTag(rendered.nodes, 'p')[0]?.props['children']).toBe('Type post:p_1 to confirm');
  });

  test('the submit stays disabled until the typed token matches exactly', () => {
    const submitOf = (confirmation: string): unknown => {
      const rendered = render(recordingAuthz(DESTROYER), { pending: pendingPurge, confirmation });
      return submit(rendered)?.props['disabled'];
    };
    expect(submitOf('')).toBe(true);
    expect(submitOf('post:p_0')).toBe(true);
    expect(submitOf('POST:P_1')).toBe(true);
    expect(submitOf('post:p_1')).toBe(false);
  });

  test('confirming runs the PENDING action with the typed token, not the pressed one', () => {
    const rendered = render(recordingAuthz(DESTROYER), {
      pending: pendingPurge,
      confirmation: 'post:p_1',
    });
    const button = submit(rendered);
    expect(button).toBeDefined();
    if (button === undefined) return;

    fire(button, 'onClick', {});
    expect(rendered.ran).toEqual([['post.purge', 'post:p_1']]);
  });

  test('with nothing pending the submit click runs nothing', () => {
    const rendered = render(recordingAuthz(DESTROYER), { confirmation: 'post:p_1' });
    const button = submit(rendered);
    expect(button).toBeDefined();
    if (button === undefined) return;

    fire(button, 'onClick', {});
    expect(rendered.ran).toEqual([]);
  });

  test('closing the dialog cancels rather than running', () => {
    const rendered = render(recordingAuthz(DESTROYER), { pending: pendingPurge });
    fire(one(byComponent(rendered.nodes, 'Dialog'), '<Dialog>'), 'onClose', {});
    expect(rendered.cancelled).toEqual([1]);
    expect(rendered.ran).toEqual([]);
  });
});

describe('a subject-less action bar still has a confirmation token', () => {
  test('a global action confirms against "admin:" rather than against "undefined:undefined"', () => {
    const global: AdminAction = {
      name: 'post.purge',
      permission: 'post:purge',
      destructive: true,
      handle: async (): Promise<unknown> => ({ ok: true }),
    };
    const rendered = render(recordingAuthz(DESTROYER), { subject: undefined }, [global]);
    expect(byTag(rendered.nodes, 'p')[0]?.props['children']).toBe('Type admin: to confirm');
  });
});

describe('the label key', () => {
  test('an action with no labelKey is labelled admin.action.<name>', () => {
    const rendered = render(recordingAuthz(EDITOR));
    expect(one(buttons(rendered), 'the publish button').props['children']).toBe('Publish (probe)');
  });

  test('a declared labelKey wins over the derived one', () => {
    const relabelled: AdminAction = { ...publish, labelKey: 'admin.actions.label' };
    const rendered = render(recordingAuthz(EDITOR), {}, [relabelled]);
    expect(one(buttons(rendered), 'the publish button').props['children']).toBe('Actions (probe)');
  });
});

describe('the confirmation box reports what was typed', () => {
  /**
   * `onInput` narrows through `instanceof HTMLInputElement`, which Bun's server runtime does not
   * define — so the browser-only global is installed for this test and handed back afterwards.
   * The descriptor, not the value: whatever the process had must survive, including nothing.
   */
  const withDomGlobal = (run: (element: object) => void): void => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement');
    class FakeInput {
      value = '';
    }
    Object.defineProperty(globalThis, 'HTMLInputElement', {
      value: FakeInput,
      configurable: true,
      writable: true,
    });
    try {
      const element = new FakeInput();
      element.value = 'post:p_1';
      run(element);
    } finally {
      if (before === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement');
      else Object.defineProperty(globalThis, 'HTMLInputElement', before);
    }
  };

  test('the input element value reaches the route', () => {
    withDomGlobal((element) => {
      const rendered = render(recordingAuthz(DESTROYER));
      fire(one(byTag(rendered.nodes, 'input'), 'the confirmation box'), 'onInput', {
        currentTarget: element,
      });
      expect(rendered.typedInput).toEqual(['post:p_1']);
    });
  });

  test('an event with no input element behind it reports the empty string, not the token', () => {
    withDomGlobal(() => {
      const rendered = render(recordingAuthz(DESTROYER));
      fire(one(byTag(rendered.nodes, 'input'), 'the confirmation box'), 'onInput', {
        currentTarget: { value: 'post:p_1' },
      });
      // Fails CLOSED: a target the narrowing does not recognise must not be read as a match for
      // the token, or the submit button unlocks on something that is not an input.
      expect(rendered.typedInput).toEqual(['']);
    });
  });
});
