// The `nats` client is 65 modules and ~545 kB of source, and every role of every app loaded it —
// realtime on or off, bus or no bus — because `server.ts` re-exported the adapter statically.
// Proved in a child process: a test process has usually loaded `nats` through some other file.

import { expect, test } from 'bun:test';
import { openNatsClient } from './nats-open';

const PROBE = `
const loaded = () => Object.keys(require.cache).filter((key) => /\\/node_modules\\/(?:nats|nkeys\\.js|tweetnacl)\\//.test(key)).length;
const server = await import(${JSON.stringify(`${import.meta.dir}/server.ts`)});
const imported = loaded();
// The in-process bus and a NATS transport nobody has dialled yet: neither needs the library.
server.selectTransport({}, { enabled: true, transport: 'memory' });
new server.NatsTransport({ url: 'nats://127.0.0.1:1', bucket: 'x' });
const constructed = loaded();
// Opening a client is the point of use. A budget that is no number is refused before any socket
// opens, so this settles at once — and the adapter, with the library behind it, is loaded by then.
await server.openNatsClient({ url: 'nats://127.0.0.1:1', maxReconnectAttempts: Number.NaN }).catch(() => undefined);
console.log(JSON.stringify({ imported, constructed, opened: loaded() > 0 }));
`;

test('importing the realtime server loads no nats module; opening a client does', async () => {
  const child = Bun.spawn(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect([await child.exited, err]).toEqual([0, '']);
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({
    imported: 0,
    constructed: 0,
    opened: true,
  });
}, 30_000);

test('the door is the adapter: a refusal made before the dial arrives through it unchanged', async () => {
  const thrown: unknown = await openNatsClient({
    url: 'nats://127.0.0.1:1',
    maxReconnectAttempts: Number.NaN,
  }).then(
    () => expect.unreachable('expected a refusal'),
    (error: unknown) => error,
  );
  expect(thrown).toMatchObject({ cause: expect.stringContaining('maxReconnectAttempts') });
});
