// The jobs dashboard over MCP is the admin's own projection — no tool written for jobs. The tools
// the audit plan promised (list, status, retry, tasks) and pause fall out of the resources and the
// actions, gated by the same decision: `job:read` lists them, `job:manage` runs them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetJobDriver } from '@ultimat3/jobs';
import type { AdminApp } from '../admin';
import { jobsAdmin, MANAGER, READER, type Seeded, seedQueue } from './jobs-fixture';

const { adminMcpTools, adminToolCatalog } = await import('../mcp-tools');
const { callAdminTool } = await import('../mcp');

let manager: AdminApp;
beforeAll(() => {
  manager = jobsAdmin('/mcp-manage', MANAGER);
});
let reader: AdminApp;
beforeAll(() => {
  reader = jobsAdmin('/mcp-read', READER);
});
const actor = { id: 'agent-ops' };
let seeded: Seeded;

beforeAll(async () => {
  seeded = await seedQueue();
});

afterAll(() => {
  resetJobDriver();
});

const LIST = 'admin.x_jobs.list';
const STATUS = 'admin.x_jobs.read';
const RETRY = 'admin.action.job.retry';
const PAUSE = 'admin.action.job.queue.pause';
const TASKS = 'admin.x_job_tasks.list';

describe('the jobs tools', () => {
  test('the catalog carries list, status, retry, tasks and pause', () => {
    const names = adminToolCatalog(manager).map((tool) => tool.name);
    for (const name of [LIST, STATUS, RETRY, PAUSE, TASKS]) expect(names).toContain(name);
  });

  test('job:read lists and reads, and is offered no tool that changes the queue', () => {
    const names = adminMcpTools(reader, reader.ctx({ actor, requestId: 'r' })).map((t) => t.name);
    expect(names).toContain(LIST);
    expect(names).toContain(STATUS);
    expect(names).toContain(TASKS);
    expect(names.filter((name) => name.startsWith('admin.action.job.'))).toEqual([]);
  });

  test('list, status and retry are the screens’ own calls', async () => {
    const ctx = manager.ctx({ actor, requestId: 'mcp' });
    const listed = await callAdminTool(manager, ctx, LIST, { scope: 'dead' });
    if (!listed.ok) return expect.unreachable(`list refused: ${listed.reason}`);
    expect(JSON.stringify(listed.data)).toContain(seeded.ids.dead);

    const status = await callAdminTool(manager, ctx, STATUS, { id: seeded.ids.dead });
    if (!status.ok) return expect.unreachable(`status refused: ${status.reason}`);
    expect(JSON.stringify(status.data)).toContain('X_BOOM');
    expect(JSON.stringify(status.data)).not.toContain('CANARY-SECRET');

    const retried = await callAdminTool(manager, ctx, RETRY, { id: seeded.ids.dead });
    expect(retried.ok).toBe(true);
    expect((await seeded.operator.job(seeded.ids.dead))?.state).toBe('ready');

    const paused = await callAdminTool(manager, ctx, PAUSE, { id: 'default' });
    expect(paused.ok).toBe(true);
    expect((await seeded.operator.pausedQueues()).map((one) => one.name)).toEqual(['default']);
  });

  test('a retry called by a reader is refused before it reaches the queue', async () => {
    const refused = await callAdminTool(reader, reader.ctx({ actor, requestId: 'r' }), RETRY, {
      id: seeded.ids.failed,
    });
    expect(refused.ok).toBe(false);
    expect((await seeded.operator.job(seeded.ids.failed))?.state).toBe('failed');
  });
});
