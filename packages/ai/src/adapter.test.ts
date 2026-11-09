// The `aiGateway` port: installed from `@ultimat3/ai/adapter` and nowhere else on the barrel, and
// every install answers a release that puts back exactly the gateway it replaced.

import { afterEach, describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import type { Gateway } from './gateway';
import * as barrel from './index';
import {
  aiGateway,
  configureAi,
  installedGateway,
  resetAiRuntime,
  semanticCacheFor,
} from './runtime';

const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();

/** A marker: nothing calls it, the slot is what is under test. */
const gateway = (name: string): Gateway => ({ name }) as unknown as Gateway;

afterEach(resetAiRuntime);

describe('@ultimat3/ai/adapter', () => {
  test('package.json maps ./adapter to this file', () => {
    expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  });

  test('carries the installer and the errors a gateway driver throws; the barrel has no installer', () => {
    expect(typeof adapter.installAiGateway).toBe('function');
    expect(typeof adapter.AiProviderUnavailableError).toBe('function');
    expect(Object.keys(barrel)).not.toContain('installAiGateway');
  });
});

describe('installAiGateway', () => {
  test('an installed gateway is the one an llm() action reaches', () => {
    const one = gateway('one');
    adapter.installAiGateway(one);
    expect(aiGateway('p')).toBe(one);
  });

  test('releases stack: each puts back exactly what it replaced', () => {
    const a = gateway('a');
    const b = gateway('b');
    const releaseA = adapter.installAiGateway(a);
    const releaseB = adapter.installAiGateway(b);
    expect(installedGateway()).toBe(b);
    releaseB();
    expect(installedGateway()).toBe(a);
    releaseA();
    expect(installedGateway()).toBeUndefined();
    expect(() => aiGateway('p')).toThrow(/X_AI_GATEWAY_MISSING/);
  });

  test('configureAi configures the rest of the runtime and never the gateway', () => {
    const installed = gateway('installed');
    adapter.installAiGateway(installed);
    configureAi({});
    expect(installedGateway()).toBe(installed);
    // @ts-expect-error — `gateway` left configureAi in 31.0.0: `aiGateway` in apps/<app>/runtime.ts.
    configureAi({ gateway: gateway('ignored') });
    expect(installedGateway()).toBe(installed);
  });

  test('the X_AI_GATEWAY_MISSING fix names the runtime.ts slot, not configureAi', () => {
    let fix = '';
    try {
      aiGateway('p');
    } catch (error) {
      fix = String((error as { fix?: unknown }).fix);
    }
    expect(fix).toContain('aiGateway:');
    expect(fix).not.toContain('configureAi');
  });

  test('a release run twice is still one release', () => {
    const a = gateway('a');
    adapter.installAiGateway(a);
    const release = adapter.installAiGateway(gateway('b'));
    release();
    release();
    expect(installedGateway()).toBe(a);
  });

  test('releases out of order: the earlier release leaves the later install standing', () => {
    const a = gateway('a');
    const b = gateway('b');
    const releaseA = adapter.installAiGateway(a);
    const releaseB = adapter.installAiGateway(b);
    releaseA();
    expect(installedGateway()).toBe(b);
    releaseB();
    expect(installedGateway()).toBeUndefined();
  });

  test('a gateway swap forgets the semantic caches, both ways — no answer crosses gateways', () => {
    adapter.installAiGateway(gateway('a'));
    const underA = semanticCacheFor('scope');
    const release = adapter.installAiGateway(gateway('b'));
    const underB = semanticCacheFor('scope');
    expect(underB).not.toBe(underA);
    release();
    expect(semanticCacheFor('scope')).not.toBe(underB);
  });
});
