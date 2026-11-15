// `x dev --tls --once` on a minimal app: the certificate generated into `.x/tls/`, the url https,
// the path printed so it can be trusted — and a second run serving the same cached certificate.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import { devCommand } from './cmd-dev';
import { devSpec } from './cmd-dev-spec';
import type { Runner } from './exec';
import { parseArgs } from './parse';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noRunner: Runner = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

/** `--once` stops the server, which drains this process's one lifecycle: reset for the next. */
const runOnce = async (root: string) => {
  try {
    return await devCommand.run({
      args: parseArgs(['dev', '--once', '--tls', '--port', '0', '--json'], [devSpec]),
      cwd: root,
      env: { ULTIMATE_ENV: 'development' },
      runner: noRunner,
      bunVersion: Bun.version,
    });
  } finally {
    resetLifecycle();
  }
};

test('x dev --tls serves https with a cached local certificate and names where it is', async () => {
  // Inside this package, so the fixture's `@ultimat3/*` imports resolve.
  const root = mkdtempSync(join(import.meta.dir, '..', '.dev-tls-cmd-fixture-'));
  dirs.push(root);
  await Bun.write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dev-tls', version: '1.0.0' }),
  );
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'dev-tls' };\n");
  const first = await runOnce(root);
  const data = first.data as { url: string; introspect: string; tls: { certPath: string } };
  expect(data.url).toStartWith('https://localhost:');
  expect(data.introspect).toStartWith('https://localhost:');
  expect(data.tls.certPath).toBe(join(root, '.x', 'tls', 'cert.pem'));
  expect(first.lines?.some((line) => line.includes(data.tls.certPath))).toBe(true);
  const cert = await Bun.file(data.tls.certPath).text();
  await runOnce(root);
  expect(await Bun.file(data.tls.certPath).text()).toBe(cert);
}, 120_000);
