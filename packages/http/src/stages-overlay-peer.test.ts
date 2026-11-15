// The dev overlay — cause, stack, absolute paths, SQL — is for THIS machine. `x dev --host
// 0.0.0.0` puts the process on a LAN, so a LAN browser (or a relay in front of a loopback socket)
// gets the page a production visitor gets. Each case below is one exploit the gate closes.
import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { httpRouter, type Route } from './router';

const SECRET = 'connect ECONNREFUSED 10.0.0.7:5432';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/boom',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      // Coded, as a real fault reaching the overlay is: its cause is what a LAN peer must not read.
      throw new UltimateError({
        code: 'X_INTERNAL',
        cause: SECRET,
        fix: 'x errors explain X_INTERNAL',
      });
    },
  },
  {
    method: 'GET',
    path: '/ok',
    meta: { name: 'ok', auth: 'public' },
    handler: () => new Response('ok'),
  },
];

const pipeline = (hops?: number) =>
  httpPipeline({
    table: httpRouter(routes),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: true,
      buildId: null,
      ...(hops === undefined ? {} : { trustProxy: true, trustedProxyHops: hops }),
    }),
  });

const browser = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/boom', { headers: { accept: 'text/html', ...headers } });

const body = async (hops: number | undefined, ip: string, headers?: Record<string, string>) => {
  const response = await pipeline(hops).handle(browser(headers), { role: 'web', ip });
  expect(response.status).toBe(500);
  return await response.text();
};

describe('unit · the dev overlay answers a loopback caller only', () => {
  test('a loopback browser gets the overlay, cause and all', async () => {
    expect(await body(undefined, '127.0.0.1')).toContain(SECRET);
  });

  test('a LAN browser on a wide bind gets the generic page', async () => {
    expect(await body(undefined, '192.168.1.50')).not.toContain(SECRET);
  });

  test('a LAN socket forging x-forwarded-for: 127.0.0.1 past one declared hop gets the generic page', async () => {
    expect(await body(1, '192.168.1.50', { 'x-forwarded-for': '127.0.0.1' })).not.toContain(SECRET);
  });

  test('a relay on loopback (a Host-rewriting tunnel) gets the generic page', async () => {
    for (const relay of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      expect(await body(undefined, '127.0.0.1', { [relay]: '203.0.113.9' })).not.toContain(SECRET);
    }
  });
});

describe('unit · the dev Server-Timing breakdown answers a loopback caller only', () => {
  const timingFor = async (ip: string, headers: Record<string, string> = {}) => {
    const response = await pipeline().handle(new Request('http://localhost/ok', { headers }), {
      role: 'web',
      ip,
    });
    return response.headers.get('server-timing') ?? '';
  };

  test('a loopback caller gets the stage breakdown', async () => {
    expect(await timingFor('127.0.0.1')).toContain('handler;dur=');
  });

  test('a LAN caller, or a relay on loopback, gets total alone — no timing oracle', async () => {
    for (const timing of [
      await timingFor('192.168.1.50'),
      await timingFor('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }),
    ]) {
      expect(timing).toStartWith('total;dur=');
      expect(timing).not.toContain(',');
    }
  });
});

describe('unit · the dev problem document withholds the cause from a caller that is not local', () => {
  const problemFor = async (ip: string, accept: string, headers: Record<string, string> = {}) => {
    const response = await pipeline().handle(
      new Request('http://localhost/boom', { headers: { accept, ...headers } }),
      { role: 'web', ip },
    );
    expect(response.status).toBe(500);
    return await response.text();
  };

  test('a loopback agent asking for json gets the cause', async () => {
    expect(await problemFor('127.0.0.1', 'application/json')).toContain(SECRET);
  });

  test('a LAN agent asking for json or */*, or a relayed one, gets no cause', async () => {
    expect(await problemFor('192.168.1.50', 'application/json')).not.toContain(SECRET);
    expect(await problemFor('192.168.1.50', '*/*')).not.toContain(SECRET);
    expect(
      await problemFor('127.0.0.1', 'application/json', { 'x-forwarded-for': '203.0.113.9' }),
    ).not.toContain(SECRET);
  });
});
