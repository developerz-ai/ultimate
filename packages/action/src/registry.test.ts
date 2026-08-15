import { beforeEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { type ActionDef, action } from './action';
import { derivePath } from './naming';
import {
  describeActions,
  getAction,
  registerAction,
  registerActions,
  resetRegistry,
} from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const define = () =>
  action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    handle: () => ({ id: POST_ID, published: true }),
  });

describe('registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('names actions from their export names', () => {
    registerActions({ publishPost: define(), archivePost: define() });
    expect(describeActions().map((entry) => entry.path)).toEqual([
      '/api/posts/archive',
      '/api/posts/publish',
    ]);
    expect(getAction('publishPost')?.name).toBe('publishPost');
  });

  test('the module export itself is what gets named, not a copy of it', () => {
    // Boot registers `await import('./actions')`; the app keeps calling the binding it
    // imported. If registration named a twin, every `publishPost.tool()` in app code
    // would throw X_ACTION_UNREGISTERED after a successful boot.
    const publishPost = define();
    const registered = registerAction('publishPost', publishPost);
    expect(registered).toBe(publishPost);
    expect(publishPost.name).toBe('publishPost');
    expect(publishPost.tool().action).toBe('publishPost');
  });

  test('a second name yields a twin, so the first registration keeps its own', () => {
    const publishPost = define();
    registerAction('publishPost', publishPost);
    const twin = registerAction('archivePost', publishPost);
    expect(twin).not.toBe(publishPost);
    expect(publishPost.name).toBe('publishPost');
    expect(getAction('archivePost')?.name).toBe('archivePost');
  });

  test('a duplicate name is X_ACTION_DUPLICATE', () => {
    registerAction('publishPost', define());
    let code: unknown;
    try {
      registerAction('publishPost', define());
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_ACTION_DUPLICATE');
  });

  test('registering the same action twice under the same name is one registration', () => {
    // `defineApi` registers a feature module at boot; the framework's module scan reaches the
    // same declaration file directly. Both arrive at the identical object, so the second call
    // is the first one seen twice — not the collision `X_ACTION_DUPLICATE` refuses.
    const publishPost = define();
    expect(registerAction('publishPost', publishPost)).toBe(publishPost);
    expect(registerAction('publishPost', publishPost)).toBe(publishPost);
    expect(getAction('publishPost')).toBe(publishPost);
    expect(describeActions()).toHaveLength(1);
  });

  test('re-registering a whole module is a no-op, not a collision', () => {
    const module = { publishPost: define(), archivePost: define() };
    registerActions(module);
    registerActions(module);
    expect(describeActions().map((entry) => entry.name)).toEqual(['archivePost', 'publishPost']);
  });

  test('a DIFFERENT action under a taken name is still X_ACTION_DUPLICATE', () => {
    // The idempotence above must not become a licence to overwrite: two features exporting one
    // name have to collide, or the last import silently wins and a surface serves the wrong one.
    registerAction('publishPost', define());
    const other = define();
    let code: unknown;
    try {
      registerAction('publishPost', other);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_ACTION_DUPLICATE');
    expect(getAction('publishPost')).not.toBe(other);
  });

  test('an action without a policy fails at registration', () => {
    // The type forbids this; the runtime check is what protects a JS caller and
    // a generator template that forgot the line.
    const unguarded = action({
      input: Input,
      output: Output,
      handle: () => ({ id: POST_ID, published: true }),
    } as unknown as ActionDef<typeof Input, typeof Output>);

    let code: unknown;
    try {
      registerAction('publishPost', unguarded);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_ACTION_POLICY_MISSING');
    expect(getAction('publishPost')).toBeUndefined();
  });
});

describe('one derived path, one action', () => {
  beforeEach(() => {
    resetRegistry();
  });

  const declare = define;

  // `pluralize` leaves a trailing `s` alone by design, so these are two names and one route.
  // `X_ACTION_DUPLICATE` only guards names: both registered, both projected, and the router
  // seated whichever came last — the other unreachable over HTTP while its OpenAPI operation
  // and MCP tool went on advertising it.
  test('refuses a second action deriving a path another already owns', () => {
    registerAction('archiveOrder', declare());

    expect(() => registerAction('archiveOrders', declare())).toThrow('X_ACTION_PATH_DUPLICATE');
    expect(getAction('archiveOrders')).toBeUndefined();
    expect(derivePath('archiveOrder').path).toBe(derivePath('archiveOrders').path);
  });

  test('the refusal names both actions and the path they collide on', () => {
    registerAction('archiveOrder', declare());
    const failure = (() => {
      try {
        registerAction('archiveOrders', declare());
        return undefined;
      } catch (error: unknown) {
        return error as { cause?: string };
      }
    })();

    expect(failure?.cause).toBe(
      'actions "archiveOrders" and "archiveOrder" both derive /api/orders/archive',
    );
  });

  test('two actions with different paths both register', () => {
    registerAction('archiveOrder', declare());
    registerAction('publishOrder', declare());

    expect(getAction('archiveOrder')).toBeDefined();
    expect(getAction('publishOrder')).toBeDefined();
  });

  test('re-registering the same action under the same name is still one registration', () => {
    const target = declare();
    registerAction('archiveOrder', target);
    expect(() => registerAction('archiveOrder', target)).not.toThrow();
  });
});
