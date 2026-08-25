// The submit path, and the one property that is not a feature: the server decides. Every case here
// is a way a form could report success — or a corrected value — that no server ever agreed to.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { createFormBinding } from './form-binding';
import type { FormIssue, FormSchema, FormValidationResult } from './form-issue';
import type { FormState } from './form-state';

const raw = (found: FormIssue): string => found.message;

/** A schema in the one shape this package declares: Standard Schema's single member. */
const schemaOf = (validate: (value: unknown) => FormValidationResult): FormSchema => ({
  '~standard': { validate },
});

interface Saved {
  readonly id: string;
}

describe('createFormBinding', () => {
  test('a form field the path grammar cannot read is refused where it is declared', () => {
    expect(() =>
      createFormBinding<{ title: string }, Saved>({
        fields: ['items.0.price'],
        messageFor: raw,
        submit: () => Promise.resolve({ id: 'x' }),
      }),
    ).toThrow(expect.objectContaining({ code: UI_ERROR_CODES.formPathInvalid }));
  });

  test('succeeds only through the server call, and carries its answer', async () => {
    const calls: unknown[] = [];
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: (values) => {
        calls.push(values);
        return Promise.resolve({ id: 'post-1' });
      },
    });

    const state = await form.submit({ title: 'Hello' });
    expect(state.status).toBe('succeeded');
    expect(state.result).toEqual({ id: 'post-1' });
    expect(calls).toEqual([{ title: 'Hello' }]);
    expect(form.state().formErrors).toEqual([]);
  });

  test('a local parse failure never reaches the network, and lands on the field', async () => {
    let called = 0;
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      schema: schemaOf(() => ({ issues: [{ message: 'too short', path: ['title'] }] })),
      submit: () => {
        called += 1;
        return Promise.resolve({ id: 'post-1' });
      },
    });

    const state = await form.submit({ title: '' });
    expect(state.status).toBe('failed');
    expect(called).toBe(0);
    expect(form.errorFor('title')).toBe('too short');
  });

  /**
   * The client's parse OUTPUT is thrown away — only its issues are read. A binding that submitted
   * the coerced value would let the browser decide what the server was asked to store.
   */
  test('submits the caller’s values, never the value the local parse produced', async () => {
    const calls: unknown[] = [];
    const form = createFormBinding<{ price: string }, Saved>({
      fields: ['price'],
      messageFor: raw,
      schema: schemaOf(() => ({ value: { price: 999 } })),
      submit: (values) => {
        calls.push(values);
        return Promise.resolve({ id: 'post-1' });
      },
    });

    await form.submit({ price: '5' });
    expect(calls).toEqual([{ price: '5' }]);
  });

  test('a server rejection lands on the field it names', async () => {
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () =>
        Promise.reject({
          code: 'X_INPUT_INVALID',
          cause: 'input for action "createPost" failed validation: title: already taken',
        }),
    });

    const state = await form.submit({ title: 'Hello' });
    expect(state.status).toBe('failed');
    expect(form.errorFor('title')).toBe('already taken');
    expect(state.formErrors).toEqual([]);
  });

  test('a server rejection naming no declared field is surfaced at the form', async () => {
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.reject({ code: 'X_FORBIDDEN', cause: 'policy "post:create" denied' }),
    });

    const state = await form.submit({ title: 'Hello' });
    expect(state.formErrors).toEqual(['policy "post:create" denied']);
    expect(form.errorFor('title')).toBeUndefined();
  });

  test('publishes every transition, starting with a submitting state that holds no stale error', async () => {
    const seen: FormState<Saved>[] = [];
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      onState: (state) => seen.push(state),
      submit: () => Promise.reject({ code: 'X_FORBIDDEN', cause: 'denied' }),
    });

    await form.submit({ title: 'a' });
    await form.submit({ title: 'b' });

    expect(seen.map((state) => state.status)).toEqual([
      'submitting',
      'failed',
      'submitting',
      'failed',
    ]);
    expect(seen[2]?.formErrors).toEqual([]);
  });

  test('a second submit while one is in flight joins it — a double click is not a second write', async () => {
    let called = 0;
    let release = (): void => {};
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => {
        called += 1;
        return new Promise<Saved>((resolve) => {
          release = () => resolve({ id: 'post-1' });
        });
      },
    });

    const first = form.submit({ title: 'a' });
    const second = form.submit({ title: 'b' });
    release();
    expect(await first).toBe(await second);
    expect(called).toBe(1);
  });

  test('a success after a failure clears what the failure wrote', async () => {
    let refuse = true;
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () =>
        refuse
          ? Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short' })
          : Promise.resolve({ id: 'post-1' }),
    });

    await form.submit({ title: '' });
    expect(form.errorFor('title')).toBe('too short');
    refuse = false;
    await form.submit({ title: 'Hello' });
    expect(form.errorFor('title')).toBeUndefined();
    expect(form.state().status).toBe('succeeded');
  });

  test('reset returns the form to idle', async () => {
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short' }),
    });
    await form.submit({ title: '' });
    form.reset();
    expect(form.state().status).toBe('idle');
    expect(form.errorFor('title')).toBeUndefined();
  });

  test('every message stays reachable when one field draws two issues', async () => {
    const form = createFormBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () =>
        Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short; title: reserved' }),
    });
    await form.submit({ title: '' });
    expect(form.messagesFor('title')).toEqual(['too short', 'reserved']);
  });
});
