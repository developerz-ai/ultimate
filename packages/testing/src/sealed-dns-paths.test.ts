// Every resolution path is sealed, NAMED IMPORT or not: these bindings are taken before
// `sealNetwork()` patches anything, which is exactly how an app module holds them. `lookup`,
// every `resolve*`, `reverse`, `lookupService`, `node:dns/promises`, `Bun.dns` and `prefetch`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: the seal must cover Bun's node:dns, so the test drives that very module, by every spelling.
import nodeDns, {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveAny,
  resolveCname,
  resolveMx,
  resolveTxt,
  reverse,
} from 'node:dns';
// why: the promise twin is its own module specifier, and its named bindings are their own.
import {
  lookup as lookupAsync,
  resolve4 as resolve4Async,
  resolveAny as resolveAnyAsync,
  resolveSrv as resolveSrvAsync,
  reverse as reverseAsync,
} from 'node:dns/promises';
import { MOCKED_HOST_ADDRESS, mockFetch, resetNetwork, sealNetwork } from './sealed-network';
import { testName } from './test-types';

sealNetwork();

afterEach(() => {
  resetNetwork();
});

type Callback = (error: unknown, answer?: unknown) => void;

/** A node callback API as a promise, so callback and promise paths share one table. */
const viaCallback = (call: (callback: Callback) => void): Promise<unknown> =>
  new Promise((done, fail) => {
    call((error, answer) => (error === null || error === undefined ? done(answer) : fail(error)));
  });

const codeOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => 'resolved',
    (error: unknown) => (error as { code?: unknown }).code,
  );

/** `Bun.dns`'s resolvers beyond `lookup` exist at runtime and are missing from its types. */
const bunDns = (name: string, ...args: unknown[]): Promise<unknown> =>
  Reflect.apply(
    Reflect.get(Bun.dns, name) as (...all: unknown[]) => Promise<unknown>,
    Bun.dns,
    args,
  );

const HOST = 'unmocked.example';
const ADDRESS = '8.8.4.4';

/** One row per path an app can reach real DNS by; every one must answer the seal's own code. */
const paths: readonly (readonly [string, () => Promise<unknown>])[] = [
  ['named lookup', () => viaCallback((cb) => lookup(HOST, cb))],
  ['named resolve', () => viaCallback((cb) => resolve(HOST, cb))],
  ['named resolve MX', () => viaCallback((cb) => resolve(HOST, 'MX', cb))],
  ['named resolve4', () => viaCallback((cb) => resolve4(HOST, cb))],
  ['named resolve6', () => viaCallback((cb) => resolve6(HOST, cb))],
  ['named resolveAny', () => viaCallback((cb) => resolveAny(HOST, cb))],
  ['named resolveCname', () => viaCallback((cb) => resolveCname(HOST, cb))],
  ['named resolveMx', () => viaCallback((cb) => resolveMx(HOST, cb))],
  ['named resolveTxt', () => viaCallback((cb) => resolveTxt(HOST, cb))],
  ['named reverse', () => viaCallback((cb) => reverse(ADDRESS, cb))],
  ['named lookupService', () => viaCallback((cb) => lookupService(ADDRESS, 53, cb))],
  ['dns.resolve4', () => viaCallback((cb) => nodeDns.resolve4(HOST, cb))],
  ['dns.promises.resolveAny', () => nodeDns.promises.resolveAny(HOST)],
  ['dns.promises.resolveNs', () => nodeDns.promises.resolveNs(HOST)],
  ['dns.promises.reverse', () => nodeDns.promises.reverse(ADDRESS)],
  ['dns/promises lookup', () => lookupAsync(HOST)],
  ['dns/promises resolve4', () => resolve4Async(HOST)],
  ['dns/promises resolveSrv', () => resolveSrvAsync(HOST)],
  ['dns/promises reverse', () => reverseAsync(ADDRESS)],
  ['Bun.dns.resolve', () => bunDns('resolve', HOST, 'A')],
  ['Bun.dns.resolveTxt', () => bunDns('resolveTxt', HOST)],
  ['Bun.dns.reverse', () => bunDns('reverse', ADDRESS)],
  ['Bun.dns.lookupService', () => bunDns('lookupService', ADDRESS, 53)],
];

describe(testName('unit', 'sealed dns, every path'), () => {
  for (const [label, call] of paths) {
    test(`${label} is refused with X_TEST_NETWORK_SEALED`, async () => {
      expect(await codeOf(call())).toBe('X_TEST_NETWORK_SEALED');
    });
  }

  test('Bun.dns.prefetch of an unmocked name throws the refusal', () => {
    expect(() => Bun.dns.prefetch(HOST, 443)).toThrow(
      expect.objectContaining({ code: 'X_TEST_NETWORK_SEALED' }),
    );
  });

  test('a mocked host answers an address query by every spelling, nothing else', async () => {
    mockFetch('https://vendor.example/*', () => new Response('{}'));
    const named = await viaCallback((cb) => lookup('vendor.example', cb));
    expect(named).toBe(MOCKED_HOST_ADDRESS);
    expect(await viaCallback((cb) => resolve4('vendor.example', cb))).toEqual([
      MOCKED_HOST_ADDRESS,
    ]);
    expect(await viaCallback((cb) => resolve('vendor.example', cb))).toEqual([MOCKED_HOST_ADDRESS]);
    expect(await resolve4Async('vendor.example', { ttl: true })).toEqual([
      { address: MOCKED_HOST_ADDRESS, ttl: 0 },
    ]);
    expect(await resolveAnyAsync('vendor.example')).toEqual([
      { type: 'A', address: MOCKED_HOST_ADDRESS, ttl: 0 },
    ]);
    expect((await lookupAsync('vendor.example')).address).toBe(MOCKED_HOST_ADDRESS);
    // A mock declares an HTTP endpoint, not a zone: an MX or a TXT record would be invented.
    expect(await codeOf(viaCallback((cb) => resolveMx('vendor.example', cb)))).toBe(
      'X_TEST_NETWORK_SEALED',
    );
    expect(await codeOf(nodeDns.promises.resolveTxt('vendor.example'))).toBe(
      'X_TEST_NETWORK_SEALED',
    );
    expect(() => Bun.dns.prefetch('vendor.example', 443)).not.toThrow();
  });

  test('a refusal no mock can lift opens its fix with the allowHost line; an address one with mockFetch', async () => {
    mockFetch('https://vendor.example/*', () => new Response('{}'));
    const fixOf = (pending: Promise<unknown>): Promise<string> =>
      pending.then(
        () => 'resolved',
        (error: unknown) => String((error as { fix?: unknown }).fix),
      );
    expect(await fixOf(nodeDns.promises.resolveMx('vendor.example'))).toStartWith(
      "allowHost('vendor.example')",
    );
    expect(await fixOf(reverseAsync('8.8.4.4'))).toStartWith("allowHost('8.8.4.4')");
    expect(await fixOf(resolve4Async(HOST))).toStartWith(`mockFetch('https://${HOST}/*'`);
  });

  test('a public address literal is refused a reverse query; a lookup of one is local', async () => {
    expect(await codeOf(reverseAsync('1.1.1.1'))).toBe('X_TEST_NETWORK_SEALED');
    expect((await lookupAsync('1.1.1.1')).address).toBe('1.1.1.1');
  });
});
