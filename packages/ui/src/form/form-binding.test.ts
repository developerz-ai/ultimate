// The submit path, and the one property that is not a feature: the server decides. Every case here
// is a way a form could report success — or a corrected value — that no server ever agreed to.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { formBinding } from './form-binding';
import type { FormIssue, FormSchema, FormValidationResult } from './form-issue';
import type { FormState } from './form-state';

const raw = (found: FormIssue): string => found.message;

/** A schema in the one shape this package declares: Standard Schema's single member. */
const schemaOf = (
  validate: (value: unknown) => FormValidationResult | Promise<FormValidationResult>,
): FormSchema => ({
  '~standard': { validate },
});

interface Saved {
  readonly id: string;
}

describe('formBinding', () => {
  test('a form field the path grammar cannot read is refused where it is declared', () => {
    expect(() =>
      formBinding<{ title: string }, Saved>({
        fields: ['items.0.price'],
        messageFor: raw,
        submit: () => Promise.resolve({ id: 'x' }),
      }),
    ).toThrow(expect.objectContaining({ code: UI_ERROR_CODES.formPathInvalid }));
  });

  test('succeeds only through the server call, and carries its answer', async () => {
    const calls: unknown[] = [];
    const form = formBinding<{ title: string }, Saved>({
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
    const form = formBinding<{ title: string }, Saved>({
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

  for (const [how, validate] of [
    [
      'throws',
      (): FormValidationResult => {
        throw new TypeError('schema bug');
      },
    ],
    ['rejects', (): Promise<FormValidationResult> => Promise.reject(new TypeError('schema bug'))],
  ] as const) {
    test(`a local validate that ${how} fails the form — it never strands it in submitting`, async () => {
      let called = 0;
      const form = formBinding<{ title: string }, Saved>({
        fields: ['title'],
        messageFor: raw,
        schema: schemaOf(validate),
        submit: () => {
          called += 1;
          return Promise.resolve({ id: 'post-1' });
        },
      });

      const state = await form.submit({ title: 'Hello' });
      expect(state.status).toBe('failed');
      expect(form.pending()).toBe(false);
      expect(called).toBe(0);
      expect(form.state().formErrors).toHaveLength(1);
    });
  }

  /**
   * The client's parse OUTPUT is thrown away — only its issues are read. A binding that submitted
   * the coerced value would let the browser decide what the server was asked to store.
   */
  test('submits the caller’s values, never the value the local parse produced', async () => {
    const calls: unknown[] = [];
    const form = formBinding<{ price: string }, Saved>({
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
    const form = formBinding<{ title: string }, Saved>({
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
    const form = formBinding<{ title: string }, Saved>({
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
    const form = formBinding<{ title: string }, Saved>({
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
    const form = formBinding<{ title: string }, Saved>({
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
    const form = formBinding<{ title: string }, Saved>({
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

  test('pending is the one value that reaches both the submit control and the form', async () => {
    let release = (): void => {};
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () =>
        new Promise<Saved>((resolve) => {
          release = () => resolve({ id: 'post-1' });
        }),
    });

    expect(form.pending()).toBe(false);
    const flight = form.submit({ title: 'a' });
    expect(form.pending()).toBe(true);
    release();
    await flight;
    expect(form.pending()).toBe(false);
  });

  test('the first invalid field is the first DECLARED one, never the first the server named', async () => {
    const form = formBinding<{ title: string; slug: string }, Saved>({
      fields: ['title', 'slug'],
      messageFor: raw,
      // Reported slug-first. Focusing in issue order would land the reader halfway down a form
      // they have not read yet.
      submit: () =>
        Promise.reject({ code: 'X_INPUT_INVALID', cause: 'slug: taken; title: too short' }),
    });

    expect(form.firstInvalidField()).toBeUndefined();
    await form.submit({ title: '', slug: '' });
    expect(form.firstInvalidField()).toBe('title');
  });

  test('a rejection naming no declared field leaves nothing to focus', async () => {
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.reject({ code: 'X_FORBIDDEN', cause: 'denied' }),
    });
    await form.submit({ title: 'a' });
    // The summary keeps the focus in this case, because there is no control to send anyone to.
    expect(form.firstInvalidField()).toBeUndefined();
    expect(form.state().formErrors).toEqual(['denied']);
  });

  test('touched and dirty are published without disturbing the submit status', () => {
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      initial: { title: 'Hello' },
      submit: () => Promise.resolve({ id: 'post-1' }),
    });

    form.touch('title');
    expect([...form.state().touched]).toEqual(['title']);
    expect([...form.state().dirty]).toEqual([]);
    expect(form.state().status).toBe('idle');

    form.edit('title', 'Hello!');
    expect([...form.state().dirty]).toEqual(['title']);
    // Back to the value it opened with: nothing to save, so nothing to warn about on the way out.
    form.edit('title', 'Hello');
    expect([...form.state().dirty]).toEqual([]);
  });

  test('an empty control on a create form is not a change', () => {
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.resolve({ id: 'post-1' }),
    });
    form.edit('title', 'a');
    form.edit('title', '');
    expect([...form.state().dirty]).toEqual([]);
  });

  test('a successful submit clears dirty — the server took what the form held', async () => {
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.resolve({ id: 'post-1' }),
    });
    form.touch('title');
    form.edit('title', 'Hello');
    const state = await form.submit({ title: 'Hello' });

    expect([...state.dirty]).toEqual([]);
    // `touched` survives: the user did visit the field, and a hint that vanishes on save flickers.
    expect([...state.touched]).toEqual(['title']);
  });

  // The server took what the form held WHEN IT SUBMITTED. A field changed while that request was in
  // flight is a change the server never saw, and clearing it let a navigation guard drop it.
  // `onState` is synchronous, so a subscriber can edit in reaction to the `submitting` publish
  // itself — before `run` reaches its first await. That edit is after the read, too.
  test('an edit made from the submitting publish is still dirty after the save', async () => {
    let edited = false;
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.resolve({ id: 'post-1' }),
      onState: (state) => {
        if (state.status !== 'submitting' || edited) return;
        edited = true;
        form.edit('title', 'typed as the save began');
      },
    });
    const state = await form.submit({ title: '' });
    expect(state.status).toBe('succeeded');
    expect([...state.dirty]).toEqual(['title']);
  });

  test('a successful submit keeps dirty the fields edited while it was in flight', async () => {
    let accept = (_saved: Saved): void => {};
    const form = formBinding<{ title: string; body: string }, Saved>({
      fields: ['title', 'body'],
      messageFor: raw,
      initial: { title: '', body: '' },
      submit: () =>
        new Promise<Saved>((resolve) => {
          accept = resolve;
        }),
    });
    form.edit('title', 'Hello');
    const flight = form.submit({ title: 'Hello', body: '' });
    form.edit('body', 'typed during the save');
    // Back to its OPENING value — but the server now holds 'Hello', so this is still a change it
    // never saw. The baseline cannot answer for an edit made after the submit read the form.
    form.edit('title', '');
    await Bun.sleep(0);
    accept({ id: 'post-1' });
    const state = await flight;

    expect(state.status).toBe('succeeded');
    expect([...state.dirty]).toEqual(['body', 'title']);

    // The NEXT save starts its own window: what the first one left dirty, it clears.
    form.edit('body', 'typed during the save');
    const second = form.submit({ title: '', body: 'typed during the save' });
    accept({ id: 'post-1' });
    expect([...(await second).dirty]).toEqual([]);
  });

  test('reset returns the form to idle', async () => {
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short' }),
    });
    await form.submit({ title: '' });
    form.touch('title');
    form.edit('title', 'x');
    form.reset();
    expect(form.state().status).toBe('idle');
    expect(form.errorFor('title')).toBeUndefined();
    expect([...form.state().touched]).toEqual([]);
    expect([...form.state().dirty]).toEqual([]);
  });

  test('every message stays reachable when one field draws two issues', async () => {
    const form = formBinding<{ title: string }, Saved>({
      fields: ['title'],
      messageFor: raw,
      submit: () =>
        Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short; title: reserved' }),
    });
    await form.submit({ title: '' });
    expect(form.messagesFor('title')).toEqual(['too short', 'reserved']);
  });
});
