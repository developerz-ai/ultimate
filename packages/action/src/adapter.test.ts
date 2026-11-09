// The `./adapter` subpath is the one place an idempotency or meter store is installed: the
// installers and their resets live there and never on the `.` barrel an action file imports.

import { afterEach, expect, test } from 'bun:test';
import * as subpath from '@ultimat3/action/adapter';
import {
  installIdempotencyStore,
  installMeterStore,
  resetIdempotency,
  resetMeterStore,
} from './adapter';
import { getIdempotencyStore } from './idempotency';
import { memoryIdempotencyStore } from './idempotency-memory';
import * as barrel from './index';
import { memoryMeterStore } from './meter-memory';
import { getMeterStore } from './meter-store';

afterEach(() => {
  resetIdempotency();
  resetMeterStore();
});

const SLOT_NAMES = [
  'installIdempotencyStore',
  'resetIdempotency',
  'installMeterStore',
  'resetMeterStore',
];

test('the package exports ./adapter, and it is the module the slots live in', async () => {
  const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  for (const name of [...SLOT_NAMES, 'IdempotencyReservationLostError']) {
    expect(Object.keys(subpath)).toContain(name);
  }
});

test('the `.` barrel exports no installer, no reset and no deleted setter', () => {
  const names = Object.keys(barrel);
  for (const name of [...SLOT_NAMES, 'installIdempotencyStore', 'installMeterStore']) {
    expect(names).not.toContain(name);
  }
});

test('installIdempotencyStore is what getIdempotencyStore() answers, until the reset', () => {
  const store = memoryIdempotencyStore();
  installIdempotencyStore(store);
  expect(getIdempotencyStore()).toBe(store);
  resetIdempotency();
  expect(getIdempotencyStore()).not.toBe(store);
});

test('installMeterStore is what getMeterStore() answers, until the reset', () => {
  const store = memoryMeterStore();
  installMeterStore(store);
  expect(getMeterStore()).toBe(store);
  resetMeterStore();
  expect(getMeterStore()).not.toBe(store);
});

/** Every `fix:` string literal in a source file, single- or double-quoted or a template. */
const FIX_LINE = /fix:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;
const SLOT_CALL = /\b(?:set|install)(?:IdempotencyStore|MeterStore)\b/;

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
  expect(SLOT_CALL.test('installIdempotencyStore(postgresIdempotencyStore({ executor }))')).toBe(
    true,
  );
});

test('installIdempotencyStore: releases in any order remove only their own install', () => {
  const a = memoryIdempotencyStore();
  const b = memoryIdempotencyStore();
  const releaseA = installIdempotencyStore(a);
  const releaseB = installIdempotencyStore(b);
  releaseA();
  expect(getIdempotencyStore()).toBe(b);
  releaseB();
  expect(getIdempotencyStore()).not.toBe(b);
  releaseB();
  releaseA();
  expect(getIdempotencyStore()).not.toBe(b);
});

test('installMeterStore: releases in any order remove only their own install', () => {
  const a = memoryMeterStore();
  const b = memoryMeterStore();
  const releaseA = installMeterStore(a);
  const releaseB = installMeterStore(b);
  releaseA();
  expect(getMeterStore()).toBe(b);
  releaseB();
  expect(getMeterStore()).not.toBe(b);
  releaseB();
  releaseA();
  expect(getMeterStore()).not.toBe(b);
});
