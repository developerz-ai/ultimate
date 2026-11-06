// Capture is armed by the config's switch, or by `x dev`'s force, and never by default.

import { afterEach, expect, test } from 'bun:test';
import { defineConfig, installedFailureStore, setFailureStore } from '@ultimat3/core';
import { armFailureCapture } from './failure-capture-boot';

afterEach(() => {
  setFailureStore(null);
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
