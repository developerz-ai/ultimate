// Single responsibility: the framework's production compose file mounts `/app/.x` owned by the uid
// its image runs as. A tmpfs mounts root-owned under `read_only: true`, so a non-root role met
// `EACCES mkdir '/app/.x/storage'` and crash-looped. The number is the chart's `runAsUser`: the
// Dockerfile names the user (`nonroot`), so the chart is where this repo writes it as a number.

import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';

const read = async (path: string): Promise<unknown> =>
  YAML.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text());

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const runAsUser = async (): Promise<unknown> => {
  const values = await read('docker/helm/values.yaml');
  return isRecord(values) && isRecord(values['podSecurityContext'])
    ? values['podSecurityContext']['runAsUser']
    : undefined;
};

describe('unit · docker/docker-compose.prod.yml owns its .x tmpfs as the image user', () => {
  test('the chart states the uid as a number', async () => {
    expect(await runAsUser()).toBe(65532);
  });

  test('every app role mounts /app/.x with that uid and gid', async () => {
    const uid = await runAsUser();
    const compose = await read('docker/docker-compose.prod.yml');
    const services = isRecord(compose) && isRecord(compose['services']) ? compose['services'] : {};
    const app = Object.entries(services).filter(([name]) => name !== 'db');
    expect(app.length).toBeGreaterThan(3);
    for (const [name, service] of app) {
      const tmpfs = isRecord(service) ? service['tmpfs'] : undefined;
      expect([name, tmpfs]).toEqual([name, ['/tmp', `/app/.x:uid=${uid},gid=${uid}`]]);
    }
  });
});
