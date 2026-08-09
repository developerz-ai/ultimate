import { beforeEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { type ActionDef, action } from './action';
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
