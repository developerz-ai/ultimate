// `x exercise` honours `apps/web/runtime.ts` (`offline-ports.ts`): an app that moved its
// `auditSink` there, as upgrade entry 43 says to, had every `audit: true` primitive answer
// `X_AUDIT_SINK_MISSING` in the pass. The pass stands a memory sink in for the app's, which it
// never writes to; an app that declares no sink still gets the refusal its server would give.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { action, resetActions, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { registeredJobs, resetJobs, restoreJobs } from '@ultimat3/jobs';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { resetQueries } from '@ultimat3/query';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { exerciseCommand } from './cmd-exercise';
import type { CommandContext } from './command';
import type { FlagValue } from './parse';
import { processRoot } from './process-root-fixture';

const WITH_SINK = processRoot(join(import.meta.dir, '..', '.exercise-ports-fixture'));
const WITHOUT_SINK = processRoot(join(import.meta.dir, '..', '.exercise-ports-bare-fixture'));
/** Where the fixture app's OWN sink records: the pass must never reach it. */
const APP_SINK_KEY = '__cxAppAuditWrites';

const RUNTIME_TS = `const writes: unknown[] = [];
Reflect.set(globalThis, '${APP_SINK_KEY}', writes);
export const runtime = { auditSink: { write: (record: unknown) => { writes.push(record); } } };
`;

const contextFor = (cwd: string): CommandContext => ({
  args: {
    command: 'exercise',
    subcommand: undefined,
    positionals: ['cxAudited'],
    flags: new Map<string, FlagValue>([['seed', '7']]),
    json: true,
    help: false,
    passthrough: [],
  },
  cwd,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: { ULTIMATE_STATE_DIR: join(cwd, '.x') },
  bunVersion: REQUIRED_BUN,
});

beforeAll(async () => {
  for (const root of [WITH_SINK, WITHOUT_SINK]) {
    await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  }
  await Bun.write(join(WITH_SINK, 'apps', 'web', 'runtime.ts'), RUNTIME_TS);
});
afterAll(async () => {
  for (const root of [WITH_SINK, WITHOUT_SINK]) await rm(root, { recursive: true, force: true });
});

const clearDeclarations = (): void => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
};
let restoreEntities: () => void = () => undefined;
let inheritedJobs: ReturnType<typeof registeredJobs> = [];
beforeEach(() => {
  restoreEntities = isolateEntityRegistry();
  inheritedJobs = registeredJobs();
  resetJobs();
  clearDeclarations();
  definePermissions(['cx:write'] as const);
  defineRoles({ writer: { grants: ['cx:write'] } });
  registerActions({
    cxAudited: action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('cx:write'),
      audit: true,
      handle: async () => ({ ok: true }),
    }),
  });
});
afterEach(() => {
  clearDeclarations();
  restoreJobs(inheritedJobs);
  restoreEntities();
});

const outcomeOf = (data: unknown): string | undefined =>
  (data as { records: { name: string; outcome: string }[] }).records.find(
    (one) => one.name === 'cxAudited',
  )?.outcome;

describe('unit · x exercise and runtime.ts', () => {
  test('an audit: true action is reached when runtime.ts declares the sink', async () => {
    const result = await exerciseCommand.run(contextFor(WITH_SINK));
    expect(outcomeOf(result.data)).toBe('reached');
    expect(result.ok).toBe(true);
    // The pass wrote to its memory stand-in, never the app's own backend.
    expect(Reflect.get(globalThis, APP_SINK_KEY)).toEqual([]);
  }, 60_000);

  test('an app that declares no sink is still refused, as its server would be', async () => {
    const result = await exerciseCommand.run(contextFor(WITHOUT_SINK));
    expect(outcomeOf(result.data)).toBe('unreached');
    expect(JSON.stringify(result.data)).toContain('X_AUDIT_SINK_MISSING');
  }, 60_000);
});
