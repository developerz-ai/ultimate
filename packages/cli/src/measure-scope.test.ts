// A build's measurement scope honours `apps/web/runtime.ts` (`offline-ports.ts`): an app whose
// `auditSink` lives there had every page reading an `audit: true` primitive filed unmeasured with
// `X_AUDIT_SINK_MISSING`. The scope stands a memory sink in for the app's, never the app's own
// backend, and takes it back on `close()`.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { getAuditSink } from '@ultimat3/core';
import { resetAuditSink } from '@ultimat3/core/adapter';
import { measureScope } from './measure-scope';
import { processRoot } from './process-root-fixture';

const WITH_SINK = processRoot(join(import.meta.dir, '..', '.measure-scope-fixture'));
const WITHOUT_SINK = processRoot(join(import.meta.dir, '..', '.measure-scope-bare-fixture'));
const APP_SINK_KEY = '__measureAppAuditSink';

const RUNTIME_TS = `const sink = { write: () => undefined };
Reflect.set(globalThis, '${APP_SINK_KEY}', sink);
export const runtime = { auditSink: sink };
`;

const INPUT = { origin: 'https://localhost', buildId: 'b1' };

beforeAll(async () => {
  await Bun.write(join(WITH_SINK, 'apps', 'web', 'runtime.ts'), RUNTIME_TS);
  await Bun.write(join(WITHOUT_SINK, 'app.config.ts'), 'export const config = {};\n');
});
afterAll(async () => {
  for (const root of [WITH_SINK, WITHOUT_SINK]) await rm(root, { recursive: true, force: true });
});
afterEach(() => resetAuditSink());

describe('unit · the measurement scope and runtime.ts', () => {
  test('a declared auditSink is stood in for by a memory sink, released on close', async () => {
    const scope = await measureScope({ ...INPUT, root: WITH_SINK });
    const installed = scope.run(() => getAuditSink());
    expect(installed).not.toBeNull();
    // Never the app's own: its backend may be production's, and this is a build.
    expect(installed).not.toBe(Reflect.get(globalThis, APP_SINK_KEY));
    await scope.close();
    expect(getAuditSink()).toBeNull();
  });

  test('an app that declares none gets none: its server would refuse, and so does the build', async () => {
    const scope = await measureScope({ ...INPUT, root: WITHOUT_SINK });
    expect(scope.run(() => getAuditSink())).toBeNull();
    await scope.close();
  });
});
