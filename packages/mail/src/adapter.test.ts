// The `./adapter` subpath is the one place a mail driver is installed: the installer and its reset
// live there and never on the `.` barrel a `defineMail` file imports (slice 21).

import { afterEach, expect, test } from 'bun:test';
import * as subpath from '@ultimat3/mail/adapter';
import { installMailDriver, resetMailDriver } from './adapter';
import { memoryMailDriver, tryMailDriver } from './driver';
import * as barrel from './index';

afterEach(() => resetMailDriver());

const SLOT_NAMES = ['installMailDriver', 'resetMailDriver'];

test('the package exports ./adapter, and it is the module the slot lives in', async () => {
  const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  for (const name of [...SLOT_NAMES, 'MailError', 'sendFailed']) {
    expect(Object.keys(subpath)).toContain(name);
  }
});

test('the `.` barrel exports no installer, no reset and no deleted setter', () => {
  const names = Object.keys(barrel);
  for (const name of [...SLOT_NAMES, 'installMailDriver']) expect(names).not.toContain(name);
});

test('installMailDriver is what tryMailDriver() answers, until the reset', () => {
  const driver = memoryMailDriver();
  installMailDriver(driver);
  expect(tryMailDriver()).toBe(driver);
  resetMailDriver();
  expect(tryMailDriver()).toBeUndefined();
});

/** Every `fix:` string literal in a source file, single- or double-quoted or a template. */
const FIX_LINE = /fix:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;
const SLOT_CALL = /\b(?:set|install)(?:MailDriver)\b/;

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
  expect(SLOT_CALL.test('setMailDriver(memoryMailDriver()) in dev')).toBe(true);
});

test('installMailDriver: releases in any order remove only their own install', () => {
  const a = memoryMailDriver();
  const b = memoryMailDriver();
  const releaseA = installMailDriver(a);
  const releaseB = installMailDriver(b);
  releaseA();
  expect(tryMailDriver()).toBe(b);
  releaseB();
  expect(tryMailDriver()).toBeUndefined();
  releaseB();
  releaseA();
  expect(tryMailDriver()).toBeUndefined();
});
