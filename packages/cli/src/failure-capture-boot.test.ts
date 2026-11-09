// Capture is armed by the config's switch, or by `x dev`'s force, and never by default.

import { afterEach, expect, test } from 'bun:test';
import type { FailureStore } from '@ultimat3/core';
import { defineConfig, installedFailureStore } from '@ultimat3/core';
import { installFailureStore } from '@ultimat3/core/adapter';
import { armFailureCapture } from './failure-capture-boot';

afterEach(() => {
  installFailureStore(null);
});

test('an app that says nothing stores nothing', async () => {
  const undo = armFailureCapture(defineConfig({ name: 'quiet' }));
  expect(installedFailureStore()).toBeNull();
  await undo();
});

test('failureCapture.enabled installs the store, and the undo takes it back out', async () => {
  const undo = armFailureCapture(defineConfig({ name: 'loud', failureCapture: { enabled: true } }));
  expect(installedFailureStore()).not.toBeNull();
  await undo();
  expect(installedFailureStore()).toBeNull();
});

test('x dev arms it whatever the file says', async () => {
  const undo = armFailureCapture(defineConfig({ name: 'quiet' }), { force: true });
  expect(installedFailureStore()).not.toBeNull();
  await undo();
});

test("the failureStore port: runtime.ts's store is the one installed, never the Postgres default", async () => {
  const mine: FailureStore = { save: async () => undefined };
  const undo = armFailureCapture(
    defineConfig({ name: 'loud', failureCapture: { enabled: true } }),
    {
      store: mine,
    },
  );
  expect(installedFailureStore()).toBe(mine);
  await undo();
  expect(installedFailureStore()).toBeNull();
});
