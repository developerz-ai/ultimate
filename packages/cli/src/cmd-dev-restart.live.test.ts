// `x dev` as a real, supervised process: a save that no re-import can serve — a slice's service
// under the query that imports it, the query DEFINING a primitive — is served by a fresh child on
// the same port. A `live` test for the reason `cmd-dev.live.test.ts` gives: it spawns `x dev` and
// boots an embedded Postgres, twice. Until 22.12 the process logged "reloaded" and kept serving the
// first service until someone restarted it by hand (notificado.co, 2026-09-29).

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { allowHost } from '@ultimat3/testing';

/** Two boots of embedded Postgres, the queue and the HTTP role — explicit, and generous. */
const TIMEOUT_MS = 120_000;
const ROOT = join(import.meta.dir, '..', '.dev-restart-fixture');
const BIN = join(import.meta.dir, 'bin.ts');
const SERVICE = 'apps/web/app/greet/service.ts';

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-restart-fixture', version: '1.0.0' }),
  // Its own repository, so the watcher's ignore walk stops here (see `cmd-dev-fixture.ts`).
  '.git/HEAD': 'ref: refs/heads/main\n',
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'dev-restart-fixture' });
`,
  [SERVICE]: `export const greeting = (): string => 'greeting one';
`,
  'apps/web/app/greet/queries.ts': `import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import { greeting } from './service';
export const greetingRead = query({
  input: t.object({}),
  policy: allow('public'),
  sql: () => from<{ id: string; text: string }>('greetings', () => [{ id: '1', text: greeting() }]).orderBy('id'),
});
`,
  'apps/web/app/greet/page.tsx': `import { defineRoute } from '@ultimat3/render';
import { greetingRead } from './queries';
export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  budget: { js: '0kb' },
  load: () => greetingRead({}),
  meta: () => ({ title: 'Greet', description: 'A page whose slice service is edited' }),
});
export function Page(props: { readonly data: readonly { readonly text: string }[] }) {
  return <main><p>{props.data[0]?.text}</p></main>;
}
`,
};

/** One pump per stream — see `cmd-dev.live.test.ts` for why a stream is never read twice. */
function pump(stream: ReadableStream<Uint8Array>): { seen: () => string } {
  const decoder = new TextDecoder();
  let seen = '';
  void (async () => {
    for await (const chunk of stream) seen += decoder.decode(chunk, { stream: true });
  })();
  return { seen: () => seen };
}

async function waitFor(output: { seen: () => string }, marker: string): Promise<string> {
  for (;;) {
    const seen = output.seen();
    if (seen.includes(marker)) return seen;
    await Bun.sleep(25);
  }
}

/** The page's body, or `''` while the port is between two children. */
const body = async (url: string): Promise<string> => {
  try {
    return await (await fetch(url)).text();
  } catch {
    return '';
  }
};

describe('x dev restarts on a save it cannot serve in process', () => {
  test(
    'an edited slice service is served by a fresh child, on the port the first one printed',
    async () => {
      await rm(ROOT, { recursive: true, force: true });
      for (const [path, contents] of Object.entries(FILES))
        await Bun.write(join(ROOT, path), contents);
      // `--port 0`: the supervisor pins ONE free port, so the second child binds the first's.
      // Its own scrape port too: the default 9090 may be a developer's running `x dev`.
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const metrics = String(probe.port);
      probe.stop(true);
      const child = Bun.spawn(['bun', BIN, 'dev', '--port', '0', '--json'], {
        cwd: ROOT,
        env: { ...Bun.env, METRICS_PORT: metrics },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = pump(child.stdout);
      const logs = pump(child.stderr);
      try {
        const first = await waitFor(output, '"command":"dev"');
        const url = /"url":"([^"]+)"/.exec(first)?.[1];
        if (url === undefined) return expect.unreachable(`no url in ${first}`);
        allowHost(new URL(url).host);
        expect(await body(`${url}/greet`)).toContain('greeting one');

        await Bun.write(join(ROOT, SERVICE), FILES[SERVICE]?.replace('one', 'two') ?? '');
        expect(await waitFor(logs, 'restarting:')).toContain(SERVICE);
        let served = '';
        while (!served.includes('greeting two')) {
          await Bun.sleep(100);
          served = await body(`${url}/greet`);
        }
        expect(served).toContain('greeting two');
        // The supervisor is still the process the terminal holds, and a signal to it stops both.
        expect(child.exitCode).toBeNull();
        child.kill('SIGINT');
        expect(await child.exited).toBe(0);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        await rm(ROOT, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
