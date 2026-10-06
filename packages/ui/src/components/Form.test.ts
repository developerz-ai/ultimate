// The focus move a failed submit makes, under the REAL Solid runtime: the bug was reactive — the
// effect re-ran on every `touch()`/`edit()` because those republish the form state — so only a
// runtime that actually re-runs effects can show it. The browser build is loaded by file, because
// the `solid-js` specifier resolves to the server build under `bun test`, where no effect runs.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { FormIssue } from '../form/form-issue';
import { useForm } from '../form/use-form';
import { attachRef, byTag, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Form } from './Form';

type Solid = typeof import('solid-js');

async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

const raw = (found: FormIssue): string => found.message;

describe('Form focus under a real Solid runtime', () => {
  let solid: Solid;

  beforeAll(async () => {
    probe();
    solid = await browserSolid();
  });
  afterAll(unprobe);
  afterEach(clearSolidRuntime);

  test('a failed submit focuses once; touching and editing afterwards never pull focus back', async () => {
    const { createContext, useContext, createSignal, createMemo, createEffect, onCleanup } = solid;
    setSolidRuntime({
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
    });

    const focused: string[] = [];
    const control = (name: string) => ({ focus: () => focused.push(name) });
    const controls = new Map([
      ['[name="title"]', control('title')],
      ['[name="body"]', control('body')],
    ]);

    let dispose = (): void => {};
    const form = solid.createRoot((done) => {
      dispose = done;
      const bound = useForm<{ title: string; body: string }, { id: string }>({
        fields: ['title', 'body'],
        messageFor: raw,
        submit: () =>
          Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short; body: required' }),
      });
      const nodes = renderNodes(Form, {
        children: null,
        get invalidField() {
          return bound.firstInvalidField();
        },
        get error() {
          return bound.state().status === 'failed' ? 'Check the fields' : undefined;
        },
      });
      attachRef(one(byTag(nodes, 'form'), '<form>'), {
        querySelector: (selector: string) => controls.get(selector) ?? null,
      });
      return bound;
    });

    try {
      await form.submit({ title: '', body: '' });
      expect(focused).toEqual(['title']);

      // The user, sent to `title`, moves on to fix `body`: every one of these republishes the
      // state, and each used to send focus back to `title` mid-keystroke.
      form.touch('title');
      form.edit('body', 'H');
      form.edit('body', 'Hi');
      expect(focused).toEqual(['title']);

      // A NEW failure is a new reason to move the reader, even naming the same field.
      await form.submit({ title: '', body: 'Hi' });
      expect(focused).toEqual(['title', 'title']);
    } finally {
      dispose();
    }
  });
});
