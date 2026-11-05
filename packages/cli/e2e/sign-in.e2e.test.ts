// A deployed scaffold reaches a policy-protected route after ONE generator command. Before
// `x g sign-in`, a production `web` role had a real authenticator and nothing that issued a session,
// so `/dashboard` answered 401 to everyone, forever (`wiki/Known-Gaps.md`, until this suite). Here:
// `x new`, `x g sign-in --password`, migrate, register one user, boot `apps/web/server.ts` as a
// production `web` role on the embedded database, sign in over HTTP, read `/dashboard`.
//
//   bun test packages/cli/e2e/sign-in.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { defineAuth, postgresAuthAdapter, register } from '@ultimat3/auth';
import { pgliteClient } from '@ultimat3/db';
import { seedId } from '@ultimat3/entity';
import { allowHost } from '@ultimat3/testing';
import { writeNewApp } from '../src/cmd-new';
import { linkWorkspace } from '../src/generate-sign-in-fixture';

const EMAIL = 'ada@example.com';
const PASSWORD = 'a long enough e2e passphrase';
const BOOT_MS = 90_000;

let dir = '';
let stateDir = '';
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

/** The CLI this checkout ships, run as the app's own `x` would be. */
const BIN = join(import.meta.dir, '..', 'src', 'bin.ts');

/**
 * One `x` command in the app, as its author runs it — in a CHILD process: `x db gen` loads the app,
 * and an app's modules register its actions, routes and authenticator process-wide. In this
 * process they outlived the suite and decided later files' answers (`bun test ./packages/cli`).
 */
const x = async (argv: readonly string[], env: Record<string, string> = {}): Promise<string> => {
  const child = Bun.spawn([process.execPath, BIN, ...argv, '--json'], {
    cwd: dir,
    env: { ...process.env, ULTIMATE_STATE_DIR: stateDir, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [text, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    expect.unreachable(
      `x ${argv.join(' ')} exited ${String(code)}: ${text} ${stderr.slice(-2000)}`,
    );
  }
  return text;
};

/** A port nothing here holds: the seeded test RNG would hand two suites the same one. */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

/** The production boot, started from the app tree the way the container starts it. */
const boot = (env: Record<string, string>) =>
  Bun.spawn([process.execPath, 'apps/web/server.ts'], {
    cwd: dir,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      ROLE: 'web',
      ULTIMATE_ENV: 'production',
      ULTIMATE_STATE_DIR: stateDir,
      HOST: '127.0.0.1',
      METRICS_PORT: String(freePort()),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

/** What any production boot refuses to start without, then the one key sign-in adds. */
const DEPLOYED = {
  SESSION_SECRET: 'b'.repeat(64),
  ULTIMATE_CURSOR_SECRET: 'c'.repeat(64),
  STORAGE_SIGNING_SECRET: 'd'.repeat(64),
};
const SECRETS = { ...DEPLOYED, ULTIMATE_SECRETS_KEY: 'a'.repeat(64) };

/**
 * Resolves once the role logs that it started, from its own stdout — an event, never a poll on the
 * wall clock. A process that exits first, or never says it, is the boot's failure with its output.
 */
const started = async (child: ReturnType<typeof Bun.spawn>): Promise<void> => {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = AbortSignal.timeout(BOOT_MS);
  let seen = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done || deadline.aborted) break;
    seen += decoder.decode(value, { stream: true });
    if (!seen.includes('"msg":"ultimate started"')) continue;
    // Kept draining: a request log that filled the pipe would stall the server mid-test.
    void (async () => {
      while (!(await reader.read()).done) {}
    })();
    return;
  }
  const stderr = await new Response(child.stderr as ReadableStream).text();
  expect.unreachable(`the web role never started: ${seen.slice(-2000)} ${stderr.slice(-2000)}`);
};

describe('x g sign-in --password, deployed', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'x-sign-in-e2e-'));
    stateDir = join(dir, '.state');
    await writeNewApp(dir, { name: 'probe', example: true });
    await linkWorkspace(dir);
    await x(['g', 'sign-in', '--password']);
    await x(['db', 'gen', 'initial']);
    await x(['db', 'migrate']);
    // The first user, made the way an operator makes one: `register()` over the app's database.
    const client = pgliteClient({ dataDir: join(stateDir, 'pgdata') });
    try {
      await register(defineAuth({ adapter: postgresAuthAdapter(client) }), {
        email: EMAIL,
        password: PASSWORD,
        orgId: seedId('org:demo'),
        roles: ['member'],
      });
    } finally {
      await client.close();
    }
    const port = freePort();
    origin = `http://127.0.0.1:${String(port)}`;
    // The sealed network admits the one origin this suite booted, and nothing else.
    allowHost(`127.0.0.1:${String(port)}`);
    server = boot({ ...SECRETS, PORT: String(port), APP_URL: origin });
    await started(server);
  }, BOOT_MS * 3);

  // The boot drains on SIGTERM inside its own deadline, so the hook waits that out.
  afterAll(async () => {
    server?.kill();
    await server?.exited;
    await rm(dir, { recursive: true, force: true });
  }, BOOT_MS);

  test('with no session the protected route is refused, as it was before the generator', async () => {
    const response = await fetch(`${origin}/dashboard`, { redirect: 'manual' });
    expect(response.status).toBe(401);
  });

  test('signing in issues the session cookie, and the protected route answers 200', async () => {
    const signedIn = await fetch(`${origin}/api/sessions/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().find((line) => line.includes('x_session'));
    if (cookie === undefined) return expect.unreachable('sign-in set no session cookie');
    const session = cookie.split(';')[0] ?? '';
    const dashboard = await fetch(`${origin}/dashboard`, { headers: { cookie: session } });
    expect(dashboard.status).toBe(200);
  });

  test('a wrong password is the one indistinguishable 401', async () => {
    const refused = await fetch(`${origin}/api/sessions/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: EMAIL, password: 'not the passphrase' }),
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.getSetCookie()).toEqual([]);
  });

  test(
    'a deployed web role with sign-in unconfigured refuses to start',
    async () => {
      const child = boot({ ...DEPLOYED, PORT: String(freePort()) });
      const code = await child.exited;
      const stderr = await new Response(child.stderr as ReadableStream).text();
      const stdout = await new Response(child.stdout as ReadableStream).text();
      expect(code).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain('X_AUTH_SIGN_IN_UNCONFIGURED');
    },
    BOOT_MS,
  );

  test(
    'a deployed role whose app module fails to load refuses to serve the rest',
    async () => {
      const broken = join(dir, 'apps/web/app/broken.ts');
      // Throws on import: a TypeError reading a property of undefined.
      await Bun.write(broken, 'export const broken = (undefined as unknown as { x: number }).x;\n');
      try {
        const child = boot({ ...SECRETS, PORT: String(freePort()) });
        const code = await child.exited;
        const stderr = await new Response(child.stderr as ReadableStream).text();
        const stdout = await new Response(child.stdout as ReadableStream).text();
        expect(code).not.toBe(0);
        expect(`${stdout}${stderr}`).toContain('X_APP_MODULE_LOAD_FAILED');
        expect(`${stdout}${stderr}`).toContain('apps/web/app/broken.ts');
      } finally {
        await rm(broken, { force: true });
      }
    },
    BOOT_MS,
  );
});
