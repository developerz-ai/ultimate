// The compose file `x new` writes is the single-node rung, and on that rung nothing else hardens a
// container or rotates its logs: the chart's `securityContext` does not reach Compose, and Docker's
// default `json-file` driver keeps every line a role ever printed on the disk the database lives on.

import { describe, expect, test } from 'bun:test';
import { drainDeadlineMs } from '@ultimat3/core';
import { names } from './naming';
import { composeProdFile } from './scaffold-container-compose';

interface Service {
  readonly image?: string;
  readonly read_only?: boolean;
  readonly tmpfs?: readonly string[];
  readonly cap_drop?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly mem_limit?: string;
  readonly stop_grace_period?: string;
  readonly logging?: { driver?: string; options?: Record<string, string> };
}

const services = (): Record<string, Service> =>
  (Bun.YAML.parse(composeProdFile(names('shop'))) as { services: Record<string, Service> })
    .services;

/** `READINESS_GRACE_DEFAULT_MS` (packages/core/src/lifecycle-grace.ts); core's barrel exports none. */
const READINESS_GRACE_DEFAULT_S = 5;

describe('unit · the scaffolded compose file is hardened and rotates its logs', () => {
  test('every app-image service runs read-only, capability-free, bounded', () => {
    const app = Object.entries(services()).filter(([name]) => name !== 'db');
    expect(app.length).toBeGreaterThan(4);
    for (const [name, service] of app) {
      expect([name, service.read_only]).toEqual([name, true]);
      // The two paths the app writes: the OS temp dir and the embedded-state directory.
      expect([name, service.tmpfs]).toEqual([name, ['/tmp', '/app/.x']]);
      expect([name, service.cap_drop]).toEqual([name, ['ALL']]);
      expect([name, service.security_opt]).toEqual([name, ['no-new-privileges:true']]);
      expect([name, typeof service.mem_limit]).toEqual([name, 'string']);
    }
  });

  test('every service, the database included, rotates its logs', () => {
    for (const [name, service] of Object.entries(services())) {
      expect([name, service.logging]).toEqual([
        name,
        { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      ]);
    }
  });

  test('the stop grace outlasts the readiness grace plus the drain deadline', () => {
    const needed = READINESS_GRACE_DEFAULT_S + drainDeadlineMs() / 1000;
    for (const [name, service] of Object.entries(services())) {
      if (name === 'db') continue;
      const seconds = Number(/^(\d+)s$/.exec(service.stop_grace_period ?? '')?.[1] ?? 0);
      expect([name, seconds > needed]).toEqual([name, true]);
    }
  });

  test('sync ships at zero replicas, with the recipe for turning it on', () => {
    const compose = composeProdFile(names('shop'));
    expect(compose).toMatch(/sync:[\s\S]*?deploy: \{ replicas: 0 \}/);
    for (const needed of ['NATS_URL', 'replicator', 'wal_level=logical', 'X_REALTIME_TOPOLOGY']) {
      expect(compose).toContain(needed);
    }
  });
});
