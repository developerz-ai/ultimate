// `x dev`'s save loop over a `deviceSocket()`: the module that declares one is re-evaluated by the
// rescan, so its path is declared again — in a new generation, which replaces the old value rather
// than colliding with it — and the listener's door at that path answers with the edited handler.
// The boot is the real one (`startDev`), the sockets are real, the save is a file on disk.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import { forgetDeviceSockets } from '@ultimat3/realtime/server';
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';
import { DEV_FIXTURE_FILES, resetRegistries } from './cmd-dev-fixture';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.dev-devices-fixture'));
const LINK = 'apps/web/app/devices/link.ts';

const link = (generation: string): string => `import { userActor } from '@ultimat3/core';
import { deviceSocket } from '@ultimat3/realtime/server';

export const deviceLink = deviceSocket({
  path: '/link',
  resolveToken: (token) =>
    token === 'ok' ? { actor: userActor({ id: 'owner', orgId: 'org-1' }), deviceId: 'desk-1' } : null,
  onFrame: ({ frame }) => ({ generation: '${generation}', received: frame }),
});
`;

const FILES: Readonly<Record<string, string>> = {
  ...DEV_FIXTURE_FILES,
  [LINK]: link('one'),
  // A second module claiming the path in the SAME scan: still refused, a finding at its file.
  'apps/web/app/devices/twin.ts': `import { deviceSocket } from '@ultimat3/realtime/server';

export const twin = deviceSocket({
  path: '/link',
  resolveToken: () => null,
  onFrame: () => ({ generation: 'twin' }),
});
`,
};
/** Generous and explicit, for the reason `cmd-dev.test.ts` gives: a hang reports as a hang. */
const BOOT_TIMEOUT_MS = 60_000;

let server: DevServer;
let onReload: (file: string) => void = () => undefined;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
  resetRegistries();
  forgetDeviceSockets();
  server = await startDev({
    root: ROOT,
    port: 0,
    env: {},
    roles: ['web'],
    onReload: (file) => onReload(file),
  });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await server?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    resetRegistries();
    forgetDeviceSockets();
    resetLifecycle();
  }
}, BOOT_TIMEOUT_MS);

type HeaderedWebSocket = new (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

interface Frame {
  readonly type?: string;
  readonly frame?: unknown;
}

interface Dialled {
  readonly closed: Promise<number>;
  /** The next frame of `type`, already received or still to come. */
  next(type: string): Promise<Frame>;
  send(frame: unknown): void;
}

/** A device's socket, raw: the frames the node sent it, read by type, and its close code. */
const dial = async (): Promise<Dialled> => {
  const url = `${server.url.replace('http', 'ws')}/link`;
  // Bun's constructor takes `{ headers }`; the DOM lib loaded beside it types no such overload.
  const ws = new (WebSocket as unknown as HeaderedWebSocket)(url, {
    headers: { authorization: 'Bearer ok' },
  });
  const frames: Frame[] = [];
  const waiting: (() => void)[] = [];
  ws.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
    for (const wake of waiting.splice(0)) wake();
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (event) => resolve(event.code)),
  );
  const next = async (type: string): Promise<Frame> => {
    for (;;) {
      const found = frames.find((frame) => frame.type === type);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
  await next('hello');
  return {
    closed,
    next,
    send: (frame) => ws.send(JSON.stringify({ type: 'frame', frame })),
  };
};

/** Writes `file`, and resolves once the watcher's rebuild landed. */
const write = (file: string, contents: string): Promise<string> => {
  const reloaded = new Promise<string>((resolve) => {
    onReload = resolve;
  });
  return Bun.write(join(ROOT, file), contents).then(() => reloaded);
};
const save = (generation: string): Promise<string> => write(LINK, link(generation));

describe('unit · x dev serves a saved deviceSocket', () => {
  test('a second declaration of the path in one scan is refused at its own file', () => {
    const twin = server.findings.find((finding) => (finding.at ?? '').endsWith('devices/twin.ts'));
    expect(twin?.code).toBe('X_CONFIG_INVALID');
    expect(twin?.cause).toContain('already declares');
  });

  test(
    'a save to link.ts: open sockets are told to redial, and /link answers with the new handler',
    async () => {
      const before = await dial();
      before.send({ status: 'idle' });
      expect((await before.next('frame')).frame).toEqual({
        generation: 'one',
        received: { status: 'idle' },
      });

      expect(await save('two')).toContain('link.ts');
      // The re-evaluated module declared its path again and was NOT refused as a duplicate.
      expect(
        server.findings
          .filter((finding) => !(finding.at ?? '').endsWith('devices/twin.ts'))
          .map((finding) => finding.code),
      ).not.toContain('X_CONFIG_INVALID');
      expect(server.findings.map((finding) => finding.code)).not.toContain(
        'X_DEV_RESTART_REQUIRED',
      );
      // The replaced declaration's sockets: a `reconnect` slot, then the close.
      expect(await before.next('reconnect')).toMatchObject({ type: 'reconnect', reason: 'drain' });
      expect(await before.closed).toBe(1001);

      const after = await dial();
      after.send({ status: 'busy' });
      expect((await after.next('frame')).frame).toEqual({
        generation: 'two',
        received: { status: 'busy' },
      });
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'a save that declares a path the listener never bound is X_DEV_RESTART_REQUIRED, at the save',
    async () => {
      const twin = 'apps/web/app/devices/twin.ts';
      await write(twin, (FILES[twin] ?? '').replace("path: '/link'", "path: '/late-link'"));
      const late = server.findings.find((finding) => finding.code === 'X_DEV_RESTART_REQUIRED');
      expect(late?.cause).toContain("deviceSocket('/late-link')");
      expect(late?.at).toContain('twin.ts');
    },
    BOOT_TIMEOUT_MS,
  );
});
