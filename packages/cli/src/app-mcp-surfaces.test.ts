// Every app directory's `mcp.ts` mounts — an admin surface's beside the web one — and each is built
// once the boot scan has registered every primitive. Driven through the real `loadApp` and the real
// `defineAppMcp`, in a child process: the scan registers into the action registry, which every other
// test file in a shared `bun test` run reads.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete or a symlink.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const CONFIG = `export const config = { name: 'demo', ai: { mcp: { expose: true } } };\n`;

/** An exposed action in the web surface's `app/` — scanned AFTER every `apps/admin/app/**` module. */
const PUBLISH = `import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
export const publishPost = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean }),
  policy: allow('posts:write'),
  mcp: { expose: true, description: 'Publish a draft post.' },
  handle: () => ({ ok: true }),
});
`;

const endpoint = (path: string): string => `import { defineAppMcp } from '@ultimat3/mcp';
export const mcp = defineAppMcp({ include: 'exposed', path: '${path}', resolveToken: () => null });
`;

/** A fixture app that resolves `@ultimat3/*` through the CLI's own workspace links. */
async function fixtureApp(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  root = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(root, 'node_modules'));
  await Bun.write(join(root, 'app.config.ts'), CONFIG);
  await Bun.write(join(root, 'apps/web/app/posts/publish.ts'), PUBLISH);
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
  return root;
}

interface Mounted {
  readonly paths?: readonly string[];
  readonly tools?: Readonly<Record<string, readonly string[]>>;
  readonly code?: string;
  readonly cause?: string;
  readonly fix?: string;
}

/** Boot the way a role does — scan, then mount — and report what mounted or what refused. */
async function boot(dir: string): Promise<Mounted> {
  const probe = `const { loadApp } = await import(${JSON.stringify(`${import.meta.dir}/app-load.ts`)});
const { appMcpMount } = await import(${JSON.stringify(`${import.meta.dir}/app-mcp.ts`)});
await loadApp(${JSON.stringify(dir)});
const toolsOf = async (file) => (await import(${JSON.stringify(dir)} + '/' + file)).mcp.tools.map((tool) => tool.name);
try {
  const mount = await appMcpMount(${JSON.stringify(dir)});
  console.log(JSON.stringify({
    paths: mount.paths,
    tools: { admin: await toolsOf('apps/admin/mcp.ts'), web: await toolsOf('apps/web/mcp.ts') },
  }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, cause: error.cause, fix: error.fix }));
}`;
  const child = Bun.spawn(['bun', '-e', probe], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  expect({ exit: await child.exited, err: err.includes('error:') ? err : '' }).toEqual({
    exit: 0,
    err: '',
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Mounted;
}

describe('every apps/<app>/mcp.ts mounts, built after the registries are full', () => {
  test("an admin surface's endpoint mounts beside the web one, and both serve the app's tools", async () => {
    const dir = await fixtureApp('x-app-mcp-surfaces-', {
      'apps/admin/mcp.ts': endpoint('/admin/mcp'),
      'apps/web/mcp.ts': endpoint('/mcp'),
    });
    // The web endpoint stays #0 (the default endpoint) although `admin` sorts first.
    expect(await boot(dir)).toEqual({
      paths: ['/mcp', '/admin/mcp'],
      tools: { admin: ['publishPost'], web: ['publishPost'] },
    });
  });

  test('two app directories claiming one path are refused, naming both files', async () => {
    const dir = await fixtureApp('x-app-mcp-surfaces-dup-', {
      'apps/admin/mcp.ts': endpoint('/mcp'),
      'apps/web/mcp.ts': endpoint('/mcp'),
    });
    const refused = await boot(dir);
    expect(refused.code).toBe('X_MCP_PATH_DUPLICATE');
    expect(refused.cause).toContain('apps/web/mcp.ts');
    expect(refused.cause).toContain('apps/admin/mcp.ts');
    expect(refused.fix).toContain('apps/admin/mcp.ts');
  });

  test("a catalog projected before the scan reached the app's actions is refused at the mount", async () => {
    // Built inside the admin surface's `app/`, which the scan evaluates before `apps/web/app/**`:
    // `include: 'exposed'` saw an empty registry. Mounted as is, `/admin/mcp` would list nothing.
    const dir = await fixtureApp('x-app-mcp-surfaces-early-', {
      'apps/admin/app/agents/agents.ts': endpoint('/admin/mcp'),
      'apps/admin/mcp.ts': `export { mcp } from './app/agents/agents';\n`,
      'apps/web/mcp.ts': endpoint('/mcp'),
    });
    const refused = await boot(dir);
    expect(refused.code).toBe('X_MCP_INCLUDE_EARLY');
    expect(refused.cause).toContain('publishPost');
    expect(refused.cause).toContain('apps/admin/mcp.ts');
    expect(refused.fix).toContain('apps/admin/mcp.ts');
  });
});
