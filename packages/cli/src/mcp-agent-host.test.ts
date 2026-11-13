// The CLI half of the agent tools: `db.explain` refuses production exactly where `x explain` does,
// `docs.search` is `x docs` (a flag-shaped question included), and `verify.narrow` answers the
// `--changed` planner's steps for one file as commands.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory native and no recursive remove; each case needs a throwaway app.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; the absolute-path case builds one.
import { join } from 'node:path';
import { isUltimateError, NotImplementedError } from '@ultimat3/core';
import type { Runner } from './exec';
import { assertExplainTarget, narrowVerify, searchDocs } from './mcp-agent-host';
import type { DevServices } from './runtime-bindings';

const services = (mode: 'embedded' | 'external'): DevServices => ({
  root: '/app',
  stateDir: '/app/.x',
  db: {
    name: 'db',
    mode,
    url: mode === 'embedded' ? 'pglite:///app/.x/pgdata' : 'postgres://db:5432/shop',
    detail: 'test',
  },
  events: { name: 'events', mode: 'embedded', url: 'inproc://events', detail: 'test' },
  storage: { name: 'storage', mode: 'embedded', url: 'file:///app/.x/storage', detail: 'test' },
});

const refusal = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (!isUltimateError(error)) expect.unreachable('expected an UltimateError');
    return error.code;
  }
  return undefined;
};

describe('assertExplainTarget is x explain’s production rule', () => {
  test('an external database in a production environment is refused', () => {
    for (const env of [{ ULTIMATE_ENV: 'production' }, { ULTIMATE_ENV: 'Production' }]) {
      expect(refusal(() => assertExplainTarget(services('external'), env))).toBe(
        'X_EXPLAIN_PRODUCTION_DATABASE',
      );
    }
  });

  test('embedded is always a dev database; external outside production is planned', () => {
    expect(refusal(() => assertExplainTarget(services('embedded'), {}))).toBeUndefined();
    expect(
      refusal(() => assertExplainTarget(services('embedded'), { ULTIMATE_ENV: 'production' })),
    ).toBeUndefined();
    expect(
      refusal(() => assertExplainTarget(services('external'), { ULTIMATE_ENV: 'staging' })),
    ).toBeUndefined();
  });
});

const noRunner: Runner = (command) => {
  throw new NotImplementedError({
    cause: `a subprocess in this test (${command.join(' ')}) is not implemented in this build`,
    fix: 'x mcp tools --json',
  });
};

describe('searchDocs runs x docs in process', () => {
  const ctx = { root: process.cwd(), env: {}, runner: noRunner };

  test('an X_* code gets x docs’ redirect to errors.explain', async () => {
    const answer = (await searchDocs(ctx, 'X_DB_DRIFT', 5)) as { data: { redirect?: string } };
    expect(answer.data.redirect).toBe('X_DB_DRIFT');
  });

  test('a question shaped like a flag is a question, never parsed as one', async () => {
    const answer = (await searchDocs(ctx, '--limit X_MCP_QUERY_REJECTED', 5)) as {
      data: { query?: string };
    };
    expect(answer.data.query).toBe('--limit X_MCP_QUERY_REJECTED');
  });
});

describe('narrowVerify is the --changed plan for one file', () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  const app = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'x-narrow-'));
    made.push(root);
    await mkdir(join(root, 'apps/web/app'), { recursive: true });
    await Bun.write(join(root, 'apps/web/app/page.tsx'), 'export const Page = () => null;\n');
    await Bun.write(join(root, 'apps/web/app/page.test.ts'), "import './page';\n");
    return root;
  };

  type Narrowed = { file: string; rule: string; steps: string[]; commands: string[] };

  test('a test file runs itself first, then only the steps a test can move', async () => {
    const root = await app();
    const answer = (await narrowVerify(root, 'apps/web/app/page.test.ts')) as Narrowed;
    expect(answer.rule).toBe('test');
    expect(answer.commands[0]).toBe('x test --filter apps/web/app/page.test.ts --json');
    expect(answer.commands[1]).toStartWith('x verify --only typecheck,lint,');
    expect(answer.steps).not.toContain('drift');
  });

  test('a page file, absolute or relative, is the same app-relative answer', async () => {
    const root = await app();
    const relative = (await narrowVerify(root, './apps/web/app/page.tsx')) as Narrowed;
    const absolute = (await narrowVerify(root, join(root, 'apps/web/app/page.tsx'))) as Narrowed;
    expect(absolute).toEqual(relative);
    expect(relative.file).toBe('apps/web/app/page.tsx');
    // A route's page is its own rule: the inner-loop steps, its route's tests first.
    expect(relative.rule).toBe('page');
    expect(relative.steps).not.toContain('manifest');
    expect(relative.commands[0]).toBe('x test --affected --dirty --json');
  });

  test('a file no rule speaks for fails open to the whole gate', async () => {
    const root = await app();
    const answer = (await narrowVerify(root, 'app.config.ts')) as Narrowed;
    expect(answer.commands).toEqual(['x verify --json']);
  });
});
