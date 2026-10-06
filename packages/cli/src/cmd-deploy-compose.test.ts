// A compose deploy starts the new container before it stops the old one, wherever compose can run
// two at once: scale up with `--no-recreate`, wait for the healthcheck, then stop and remove the
// containers that were serving before. Where it cannot — a published host port, a container_name —
// the plan says so and keeps compose's stop-first recreate. The sequence itself: cmd-deploy-start-first.test.ts.

import { describe, expect, test } from 'bun:test';
import { composeStrategies } from './cmd-deploy-compose';

const COMPOSE = `
x-common: &common
  image: \${IMAGE:-app:latest}
  stop_grace_period: 40s
services:
  migrate: { <<: *common }
  web:
    <<: *common
    ports: ['3000:3000']
    deploy: { replicas: 1 }
  sync:
    <<: *common
    ports: ['127.0.0.1:3001:3001']
  worker:
    <<: *common
    deploy: { replicas: 2 }
  scheduler:
    <<: *common
    ports: ['9090']
`;

describe('unit · which roles can start first', () => {
  test('a role publishing a fixed host port stays stop-first, and the plan names why', () => {
    const strategies = composeStrategies(COMPOSE);
    expect(strategies.get('web')).toMatchObject({ kind: 'stop-first' });
    const web = strategies.get('web');
    expect(web?.kind === 'stop-first' ? web.why : '').toContain('3000');
    // An address-bound publish is still one binder for that host port.
    expect(strategies.get('sync')).toMatchObject({ kind: 'stop-first' });
  });

  test('a role with no fixed host port starts first, at its declared replica count', () => {
    const strategies = composeStrategies(COMPOSE);
    expect(strategies.get('worker')).toEqual({ kind: 'start-first', replicas: 2 });
    // A container-only port lets Docker pick the host side, so two replicas never collide.
    expect(strategies.get('scheduler')).toEqual({ kind: 'start-first', replicas: 1 });
  });

  test('container_name, host networking and long-syntax publishes are stop-first too', () => {
    const strategies = composeStrategies(`
services:
  web: { image: a, container_name: app-web }
  sync: { image: a, network_mode: host }
  worker: { image: a, ports: [{ target: 3000, published: '8080' }] }
  scheduler: { image: a, ports: [{ target: 9090 }, '127.0.0.1::9091'] }
`);
    expect(strategies.get('web')?.kind).toBe('stop-first');
    expect(strategies.get('sync')?.kind).toBe('stop-first');
    expect(strategies.get('worker')?.kind).toBe('stop-first');
    expect(strategies.get('scheduler')).toEqual({ kind: 'start-first', replicas: 1 });
  });

  test('an unreadable compose file decides nothing: every role keeps stop-first', () => {
    for (const text of [undefined, 'services: [', 'just a string']) {
      const strategies = composeStrategies(text);
      for (const role of ['web', 'sync', 'worker', 'scheduler']) {
        expect(strategies.get(role)?.kind ?? 'stop-first').toBe('stop-first');
      }
    }
  });
});
