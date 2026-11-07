// `outbound({ dial: 'public' })`'s pin over a REAL TLS socket: the connection goes to the address
// the screen approved and the certificate is proven against the NAME (`tls.serverName`). The unit
// suite pins the init it builds; only a listener shows Bun's `fetch` honours it. Modelled on
// `@ultimat3/jobs`' `webhook-pin-tls.live.test.ts`. Opt-in (`.live.`): needs `openssl`, else skips.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory helper; the key and certificate live there for this run only.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from './errors';
import { markListening } from './listeners';
import { outbound } from './outbound';
import type { OutboundFetch } from './outbound-types';

const hasOpenssl = Bun.which('openssl') !== null;
const NAME = 'api.vendor.test';
/** The public address the screen approves; the transport below reaches it on loopback. */
const PUBLIC = '93.184.216.34';

let dir = '';
let cert = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let unannounce = (): void => undefined;
const hosts: string[] = [];

beforeAll(async () => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'x-outbound-tls-'));
  const minted = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${NAME}`,
      '-addext',
      `subjectAltName=DNS:${NAME}`,
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { timeout: 30_000 },
  );
  expect(minted.exitCode).toBe(0);
  cert = await Bun.file(join(dir, 'cert.pem')).text();
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { key: Bun.file(join(dir, 'key.pem')), cert },
    fetch: (request) => {
      hosts.push(request.headers.get('host') ?? '');
      return new Response('ok');
    },
  });
  unannounce = markListening(server.url.origin);
  // The hook's bound is the mint's own: openssl on a loaded 4-core runner (windows, `--parallel`)
  // took past bun's 5 s hook default, which killed it mid-mint and read as exit code null.
}, 30_000);

afterAll(() => {
  unannounce();
  server?.stop(true);
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** The real `fetch`: the approved address routed to the listener, this run's root trusted. */
const loopback: OutboundFetch = (url, init) =>
  fetch(url.replace(PUBLIC, '127.0.0.1'), {
    ...init,
    signal: init.signal ?? null,
    tls: { ...init.tls, ca: cert },
  } as RequestInit);

const call = (host: string) =>
  outbound(
    {
      url: `https://${host}:${server?.port ?? 0}/v1`,
      vendor: 'v',
      dial: 'public',
      deadlineMs: 10_000,
    },
    {
      fetch: loopback,
      resolve: () => Promise.resolve([PUBLIC]),
      env: { ULTIMATE_ENV: 'production' },
    },
  ).then(
    (answer) => answer.text(),
    (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
  );

describe.skipIf(!hasOpenssl)('live · outbound · a pinned public dial over real TLS', () => {
  test('reaches the approved address and verifies the certificate against the NAME', async () => {
    expect(await call(NAME)).toBe('ok');
    expect(hosts.at(-1)).toBe(`${NAME}:${server?.port ?? 0}`);
  });

  test('a certificate for another name is refused, though the address is the same', async () => {
    const before = hosts.length;
    expect(await call('other.vendor.test')).toBe('X_OUTBOUND_UNREACHABLE');
    expect(hosts.length).toBe(before);
  });
});
