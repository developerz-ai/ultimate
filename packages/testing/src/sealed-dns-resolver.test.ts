// A `Resolver` instance asks its own c-ares channel, not `Bun.dns`, so it is sealed on its two
// prototypes — the callback class and the promise class, by named import or not — and a sealed
// instance answers exactly what the module-level function of the same name answers.

import { afterEach, describe, expect, test } from 'bun:test';
// why: the seal must cover Bun's node:dns Resolver classes, so the test drives those very classes.
import nodeDns, { Resolver } from 'node:dns';
// why: the promise class is its own export of its own module specifier.
import { Resolver as PromiseResolver } from 'node:dns/promises';
import {
  MOCKED_HOST_ADDRESS,
  mockFetch,
  resetNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';
import { testName } from './test-types';

sealNetwork();

afterEach(() => {
  resetNetwork();
});

type Callback = (error: unknown, answer?: unknown) => void;

const viaCallback = (call: (callback: Callback) => void): Promise<unknown> =>
  new Promise((done, fail) => {
    call((error, answer) => (error === null || error === undefined ? done(answer) : fail(error)));
  });

const codeOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown }).code,
  );

const HOST = 'unmocked.example';

describe(testName('unit', 'sealed dns resolver'), () => {
  test('the callback Resolver refuses an unmocked name on every method', async () => {
    const resolver = new Resolver();
    const calls: readonly ((cb: Callback) => void)[] = [
      (cb) => resolver.resolve(HOST, cb),
      (cb) => resolver.resolve(HOST, 'TXT', cb),
      (cb) => resolver.resolve4(HOST, cb),
      (cb) => resolver.resolve6(HOST, cb),
      (cb) => resolver.resolveAny(HOST, cb),
      (cb) => resolver.resolveMx(HOST, cb),
      (cb) => resolver.resolveNs(HOST, cb),
      (cb) => resolver.resolveSoa(HOST, cb),
      (cb) => resolver.reverse('8.8.4.4', cb),
    ];
    for (const call of calls) expect(await codeOf(viaCallback(call))).toBe('X_TEST_NETWORK_SEALED');
  });

  test('the promise Resolver refuses an unmocked name, by either spelling', async () => {
    for (const resolver of [new PromiseResolver(), new nodeDns.promises.Resolver()]) {
      expect(await codeOf(resolver.resolve4(HOST))).toBe('X_TEST_NETWORK_SEALED');
      expect(await codeOf(resolver.resolve(HOST, 'MX'))).toBe('X_TEST_NETWORK_SEALED');
      expect(await codeOf(resolver.resolveTxt(HOST))).toBe('X_TEST_NETWORK_SEALED');
      expect(await codeOf(resolver.reverse('8.8.4.4'))).toBe('X_TEST_NETWORK_SEALED');
    }
  });

  test('a mocked host answers A through either class; another record type is refused', async () => {
    mockFetch('https://vendor.example/*', () => new Response('{}'));
    const resolver = new Resolver();
    expect(await viaCallback((cb) => resolver.resolve4('vendor.example', cb))).toEqual([
      MOCKED_HOST_ADDRESS,
    ]);
    const promised = new PromiseResolver();
    expect(await promised.resolve('vendor.example')).toEqual([MOCKED_HOST_ADDRESS]);
    expect(await promised.resolveAny('vendor.example')).toEqual([
      { type: 'A', address: MOCKED_HOST_ADDRESS, ttl: 0 },
    ]);
    expect(await codeOf(promised.resolveMx('vendor.example'))).toBe('X_TEST_NETWORK_SEALED');
  });

  test('this machine is handed to the instance’s own resolver', async () => {
    expect(await new PromiseResolver().resolve4('localhost')).toContain('127.0.0.1');
  });

  test('unseal hands back every resolver it patched, and seal takes them again', () => {
    const bunResolve = (): unknown => Reflect.get(Bun.dns, 'resolve');
    const sealedResolve = bunResolve();
    const sealedPrototype = Resolver.prototype.resolve4;
    const sealedPromise = PromiseResolver.prototype.resolveMx;
    unsealNetwork();
    try {
      expect(bunResolve()).not.toBe(sealedResolve);
      expect(Resolver.prototype.resolve4).not.toBe(sealedPrototype);
      expect(PromiseResolver.prototype.resolveMx).not.toBe(sealedPromise);
      expect((bunResolve() as { name: string }).name).not.toBe('sealed');
      expect(Resolver.prototype.resolve4.name).not.toBe('sealed');
    } finally {
      sealNetwork();
    }
    expect(Resolver.prototype.resolve4.name).toBe('sealed');
  });
});
