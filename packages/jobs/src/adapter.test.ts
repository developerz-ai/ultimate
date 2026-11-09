// The `./adapter` subpath is the one place a queue or an event bus is installed: the installers and
// their resets live there and never on the `.` barrel an app's job file imports (slice 21).

import { afterEach, expect, test } from 'bun:test';
import * as subpath from '@ultimat3/jobs/adapter';
import {
  freshDefaultEventBus,
  installEventBus,
  installJobDriver,
  resetEventBus,
  resetJobDriver,
} from './adapter';
import { jobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { eventBus, memoryEventBus } from './events';
import * as barrel from './index';

afterEach(() => {
  resetJobDriver();
  resetEventBus();
});

const SLOT_NAMES = ['installJobDriver', 'resetJobDriver', 'installEventBus', 'resetEventBus'];

test('the package exports ./adapter, and it is the module the slots live in', async () => {
  const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  for (const name of SLOT_NAMES) expect(Object.keys(subpath)).toContain(name);
});

test('the `.` barrel exports no installer, no reset and no deleted setter', () => {
  const names = Object.keys(barrel);
  for (const name of [...SLOT_NAMES, 'installJobDriver', 'installEventBus']) {
    expect(names).not.toContain(name);
  }
});

test('the driver errors a custom driver throws come with the port', () => {
  for (const name of ['ClaimQueuesEmptyError', 'JobDuplicateError', 'LeaseLostError']) {
    expect(Object.keys(subpath)).toContain(name);
  }
});

test('installJobDriver is what jobDriver() answers, until the reset', () => {
  const driver = memoryJobDriver();
  installJobDriver(driver);
  expect(jobDriver()).toBe(driver);
  resetJobDriver();
  expect(jobDriver()).toBeUndefined();
});

test('installEventBus is what eventBus() answers, and the reset is a fresh bus', () => {
  const bus = memoryEventBus();
  installEventBus(bus);
  expect(eventBus()).toBe(bus);
  resetEventBus();
  expect(eventBus()).not.toBe(bus);
});

/** Every `fix:` string literal in a source file, single- or double-quoted or a template. */
const FIX_LINE = /fix:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;
const SLOT_CALL = /\b(?:set|install)(?:JobDriver|EventBus)\b/;

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
  expect(SLOT_CALL.test('call setJobDriver(postgresJobDriver()) at boot')).toBe(true);
});

test('installJobDriver: releases in any order remove only their own install', () => {
  const a = memoryJobDriver();
  const b = memoryJobDriver();
  const releaseA = installJobDriver(a);
  const releaseB = installJobDriver(b);
  releaseA();
  expect(jobDriver()).toBe(b);
  releaseB();
  expect(jobDriver()).toBeUndefined();
  releaseB();
  releaseA();
  expect(jobDriver()).toBeUndefined();
});

test('installEventBus: releases in any order remove only their own install', () => {
  const a = memoryEventBus();
  const b = memoryEventBus();
  const releaseA = installEventBus(a);
  const releaseB = installEventBus(b);
  releaseA();
  expect(eventBus()).toBe(b);
  releaseB();
  expect(eventBus()).not.toBe(b);
  releaseB();
  releaseA();
  expect(eventBus()).not.toBe(b);
});

test('freshDefaultEventBus replaces only the default: an installed bus stays installed', async () => {
  const swapped = memoryEventBus();
  const release = installEventBus(swapped);
  freshDefaultEventBus();
  expect(eventBus()).toBe(swapped);
  release();
  const fresh = eventBus();
  await fresh.publish('probe', {});
  freshDefaultEventBus();
  expect(eventBus()).not.toBe(fresh);
});
