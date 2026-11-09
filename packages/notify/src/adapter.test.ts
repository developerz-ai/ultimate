// The `./adapter` subpath is the one place a notifier's stores are installed: the installer and
// its reset live there and never on the `.` barrel a notifier file imports (slice 21).

import { afterEach, expect, test } from 'bun:test';
import * as subpath from '@ultimat3/notify/adapter';
import { installNotifyStores, resetNotifyStores } from './adapter';
import { memoryInboxStore } from './inbox';
import * as barrel from './index';
import { notifyStores } from './stores';

afterEach(() => resetNotifyStores());

const SLOT_NAMES = ['installNotifyStores', 'resetNotifyStores'];

test('the package exports ./adapter, and it is the module the slot lives in', async () => {
  const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  for (const name of [...SLOT_NAMES, 'NotifyStoreMissingError']) {
    expect(Object.keys(subpath)).toContain(name);
  }
});

test('the `.` barrel exports no installer, no reset and no deleted setter', () => {
  const names = Object.keys(barrel);
  for (const name of [...SLOT_NAMES, 'installNotifyStores']) expect(names).not.toContain(name);
});

test('installNotifyStores is what notifyStores() answers, until the reset', () => {
  const inbox = memoryInboxStore();
  installNotifyStores({ inbox });
  expect(notifyStores().inbox).toBe(inbox);
  resetNotifyStores();
  expect(notifyStores().inbox).toBeUndefined();
});

/** Every `fix:` string literal in a source file, single- or double-quoted or a template. */
const FIX_LINE = /fix:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;
const SLOT_CALL = /\b(?:set|install)(?:NotifyStores)\b/;

test('no fix: names an installer: an app swaps the port in apps/<app>/runtime.ts', async () => {
  const offenders: string[] = [];
  for await (const name of new Bun.Glob('*.ts').scan(import.meta.dir)) {
    if (name.endsWith('.test.ts') || name === 'adapter.ts') continue;
    const text = await Bun.file(`${import.meta.dir}/${name}`).text();
    for (const [, , body] of text.matchAll(FIX_LINE)) {
      if (body !== undefined && SLOT_CALL.test(body)) offenders.push(`${name}: ${body}`);
    }
  }
  expect(offenders).toEqual([]);
  // Guards the guard: the line that shipped in this package is caught.
  expect(SLOT_CALL.test('call setNotifyStores({ inbox: memoryInboxStore() })')).toBe(true);
});

test('installNotifyStores: releases in any order remove only their own install', () => {
  const a = { inbox: memoryInboxStore() };
  const b = { inbox: memoryInboxStore() };
  const releaseA = installNotifyStores(a);
  const releaseB = installNotifyStores(b);
  releaseA();
  expect(notifyStores().inbox).toBe(b.inbox);
  releaseB();
  expect(notifyStores().inbox).toBeUndefined();
  releaseB();
  releaseA();
  expect(notifyStores().inbox).toBeUndefined();
});
