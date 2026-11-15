// supportInbox, unit: Resend's signed webhook through the real pipeline onto the in-memory queue,
// then the worker reading the raw message from a mocked Resend. What is worth failing on is
// Postly's half — the env the provider is built from, the path, what `handle` makes of a message.
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { afterEach, describe, expect, mockFetch, test, testName } from '@ultimat3/testing';
import { SUPPORT_INBOX_PATH, supportInbox } from './support-inbox';

/** `whsec_` + base64 of 24 fixed bytes: signs this file's fixtures and nothing else. */
const KEY_BYTES = new TextEncoder().encode('support-inbox-unit-key-1');
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;
const EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';
const RAW_URL = 'https://inbound-raw.resend.test/raw.eml';

const MIME = `From: Ada Lovelace <ada@customer.test>
To: support@postly.test
Subject: Export is stuck
Message-ID: <t-1@customer.test>
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: text/plain; charset=utf-8

The CSV export never finishes.
--b
Content-Type: application/pdf
Content-Disposition: attachment; filename="screenshot.pdf"

%PDF-1.4 unit
--b--
`.replace(/\n/g, '\r\n');

const WEBHOOK = JSON.stringify({
  type: 'email.received',
  created_at: '2026-10-06T12:00:00.000Z',
  data: { email_id: EMAIL_ID, to: ['support@postly.test'], received_for: ['support@postly.test'] },
});

async function svix(id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    KEY_BYTES,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

const withEnv = async (run: () => Promise<void>): Promise<void> => {
  const before = { secret: Bun.env['RESEND_INBOUND_SECRET'], key: Bun.env['RESEND_API_KEY'] };
  Bun.env['RESEND_INBOUND_SECRET'] = SECRET;
  Bun.env['RESEND_API_KEY'] = 're_unit';
  try {
    await run();
  } finally {
    if (before.secret === undefined) delete Bun.env['RESEND_INBOUND_SECRET'];
    else Bun.env['RESEND_INBOUND_SECRET'] = before.secret;
    if (before.key === undefined) delete Bun.env['RESEND_API_KEY'];
    else Bun.env['RESEND_API_KEY'] = before.key;
  }
};

async function deliver(body: string, signature?: string): Promise<Response> {
  const id = 'msg_support_unit';
  const timestamp = String(Math.floor(Date.now() / 1000));
  return httpPipeline({
    table: httpRouter(supportInbox.routes()),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  }).handle(
    new Request(`http://localhost${SUPPORT_INBOX_PATH}`, {
      method: 'POST',
      headers: {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature ?? (await svix(id, timestamp, body)),
      },
      body,
    }),
    { role: 'web' },
  );
}

afterEach(() => resetStorage());

describe(testName('unit', 'supportInbox'), () => {
  test('a signed email is queued, then read from Resend into one typed ticket', ({ runJobs }) =>
    withEnv(async () => {
      const disk = memoryStorageDriver({ signingSecret: 'unit' });
      defineStorage({ disks: { memory: disk } });
      mockFetch(`GET https://api.resend.com/emails/receiving/${EMAIL_ID}`, () =>
        Response.json({ id: EMAIL_ID, raw: { download_url: RAW_URL } }),
      );
      mockFetch(`GET ${RAW_URL}`, () => new Response(MIME));
      const response = await deliver(WEBHOOK);
      expect(await response.json()).toEqual({ ok: true, eventId: EMAIL_ID, deduped: false });
      const trace = await runJobs.drain();
      const [run] = trace.executions;
      expect(run?.outcome).toBe('completed');
      expect(run?.result).toMatchObject({
        eventId: EMAIL_ID,
        from: 'ada@customer.test',
        subject: 'Export is stuck',
      });
      expect(disk.objects().size).toBe(1);
    }));

  test('a signature over other bytes is a 401, and nothing is queued', ({ runJobs }) =>
    withEnv(async () => {
      const response = await deliver(WEBHOOK, await svix('msg_x', '1', '{}'));
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('X_MAIL_EVENT_UNVERIFIED');
      expect(await runJobs.depth(supportInbox)).toBe(0);
    }));
});
