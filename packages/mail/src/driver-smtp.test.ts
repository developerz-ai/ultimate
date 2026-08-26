// Tests for the SMTP driver: config parsing, the pool ceiling, and one real delivery over a real
// loopback socket. The live server is the point — a protocol that only ever ran against a fake
// stream has never proven that `Bun.connect`, the chunk queue and the framing agree.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { MailMessage } from './driver';
import { createSmtpDriver } from './driver-smtp';
import { mailIdempotencyKey } from './idempotency';
import type { SmtpStream, SmtpTarget } from './smtp-client';

const FROM = 'Postly <no-reply@postly.test>';

function messageFixture(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    mailId: 'welcome',
    to: ['ada@example.test'],
    subject: 'Welcome to Postly',
    html: '<p>Hello Ada — café ☕</p>',
    text: 'Hello Ada — café ☕',
    locale: 'en',
    tz: 'UTC',
    ...overrides,
  };
}

function codeOf(value: unknown): string {
  return isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;
}

function metaOf(value: unknown): Readonly<Record<string, unknown>> {
  return isUltimateError(value) ? (value.meta ?? {}) : {};
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

interface Session {
  inData: boolean;
  buffer: string;
  message: string;
}

interface LocalServer {
  readonly port: number;
  readonly commands: string[];
  readonly messages: string[];
  stop(): void;
}

/**
 * The smallest server that is still SMTP: greeting, EHLO with capabilities, envelope, DATA framed
 * by `\r\n.\r\n`. No STARTTLS — which is exactly why the driver under test must opt in explicitly.
 */
function startLocalSmtp(): LocalServer {
  const commands: string[] = [];
  const messages: string[] = [];
  const sessions = new Map<unknown, Session>();
  const decoder = new TextDecoder();

  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        sessions.set(socket, { inData: false, buffer: '', message: '' });
        socket.write('220 local.test ESMTP\r\n');
      },
      close(socket) {
        sessions.delete(socket);
      },
      data(socket, chunk) {
        const session = sessions.get(socket);
        if (session === undefined) return;
        session.buffer += decoder.decode(chunk);

        for (;;) {
          if (session.inData) {
            const end = session.buffer.indexOf('\r\n.\r\n');
            if (end === -1) return;
            session.message = session.buffer.slice(0, end);
            messages.push(session.message);
            session.buffer = session.buffer.slice(end + 5);
            session.inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          const eol = session.buffer.indexOf('\r\n');
          if (eol === -1) return;
          const line = session.buffer.slice(0, eol);
          session.buffer = session.buffer.slice(eol + 2);
          commands.push(line);
          if (line.startsWith('EHLO')) socket.write('250-local.test\r\n250 SIZE 20000000\r\n');
          else if (line.startsWith('MAIL FROM')) socket.write('250 2.1.0 Ok\r\n');
          else if (line.startsWith('RCPT TO')) socket.write('250 2.1.5 Ok\r\n');
          else if (line === 'DATA') {
            session.inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (line === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else socket.write('502 5.5.2 Command not implemented\r\n');
        }
      },
    },
  });

  return {
    port: listener.port,
    commands,
    messages,
    stop: () => listener.stop(true),
  };
}

test('a real delivery over a real socket lands the full MIME message', async () => {
  const server = startLocalSmtp();
  try {
    const driver = createSmtpDriver({
      url: `smtp://127.0.0.1:${server.port}`,
      from: FROM,
      allowInsecure: true,
      timeoutMs: 2_000,
    });
    const message = messageFixture({ cc: ['grace@example.test'], bcc: ['ops@example.test'] });

    const result = await driver.send(message);

    expect(result.driver).toBe('smtp');
    expect(result.queued).toBe(false);
    expect(result.accepted).toEqual(['ada@example.test', 'grace@example.test', 'ops@example.test']);
    expect(result.idempotencyKey).toBe(mailIdempotencyKey(message));

    expect(server.commands).toEqual([
      'EHLO postly.test',
      'MAIL FROM:<no-reply@postly.test>',
      'RCPT TO:<ada@example.test>',
      'RCPT TO:<grace@example.test>',
      'RCPT TO:<ops@example.test>',
      'DATA',
      'QUIT',
    ]);

    const raw = server.messages[0] ?? '';
    expect(raw).toContain(`Message-ID: ${result.id}`);
    expect(raw).toContain('From: Postly <no-reply@postly.test>');
    expect(raw).toContain('To: ada@example.test');
    expect(raw).toContain('Cc: grace@example.test');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    // The blind recipient reached the envelope and nothing else.
    expect(raw).not.toContain('ops@example.test');
  } finally {
    server.stop();
  }
});

test('a body far larger than one socket buffer is written whole', async () => {
  const server = startLocalSmtp();
  try {
    const driver = createSmtpDriver({
      url: `smtp://127.0.0.1:${server.port}`,
      from: FROM,
      allowInsecure: true,
      timeoutMs: 5_000,
    });
    const paragraph = `<p>${'x'.repeat(120)}</p>\n`;

    await driver.send(messageFixture({ html: paragraph.repeat(2_000), text: 'x'.repeat(200_000) }));

    const raw = server.messages[0] ?? '';
    expect(raw.length).toBeGreaterThan(400_000);
    // The closing delimiter survived the backpressure loop, so no byte in between was dropped.
    expect(raw).toMatch(/--x-ultimate-[\w-]+--$/);
  } finally {
    server.stop();
  }
});

test('a cleartext server without STARTTLS is refused when insecure sending is not opted into', async () => {
  const server = startLocalSmtp();
  try {
    const driver = createSmtpDriver({ url: `smtp://127.0.0.1:${server.port}`, from: FROM });

    const error = await caught(driver.send(messageFixture()));

    expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
    expect(metaOf(error)['stage']).toBe('starttls');
  } finally {
    server.stop();
  }
});

test('a refused connection is a transient send failure, not a bare socket error', async () => {
  const server = startLocalSmtp();
  const port = server.port;
  server.stop();
  const driver = createSmtpDriver({
    url: `smtp://127.0.0.1:${port}`,
    from: FROM,
    allowInsecure: true,
    timeoutMs: 1_000,
  });

  const error = await caught(driver.send(messageFixture()));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('connect');
  expect(metaOf(error)['retryable']).toBe(true);
});

test('poolSize caps how many conversations run at once', async () => {
  let open = 0;
  let peak = 0;
  const connector = (): Promise<SmtpStream> => {
    open += 1;
    peak = Math.max(peak, open);
    const outbox = [
      '220 local ESMTP\r\n',
      '250-local\r\n250 SIZE 100000\r\n',
      '250 Ok\r\n',
      '250 Ok\r\n',
      '354 go\r\n',
      '250 Ok: queued\r\n',
      '221 bye\r\n',
    ];
    return Promise.resolve({
      read: () => Promise.resolve(outbox.shift()),
      write: () => Bun.sleep(5),
      startTls: () => Promise.resolve(),
      close: () => {
        open -= 1;
      },
    });
  };
  const driver = createSmtpDriver({
    url: 'smtp://mail.example.test:587',
    from: FROM,
    allowInsecure: true,
    poolSize: 2,
    connect: connector,
  });

  const first = Array.from({ length: 6 }, () => driver.send(messageFixture()));
  // Arrivals after the queue has started draining: the ceiling has to hold for them too, and
  // every stream from the first batch has to have been closed rather than leaked.
  await Bun.sleep(12);
  const late = Array.from({ length: 3 }, () => driver.send(messageFixture()));

  await Promise.all([...first, ...late]);

  expect(peak).toBe(2);
  expect(open).toBe(0);
});

test('smtps defaults to 465 and smtp to 587, and credentials are percent-decoded', async () => {
  const dialed: { host: string; port: number; tls: boolean }[] = [];
  const auth: string[] = [];
  const connector = (target: SmtpTarget): Promise<SmtpStream> => {
    dialed.push({ host: target.host, port: target.port, tls: target.tls });
    // Enough of a conversation to reach AUTH; the send then dies on an empty outbox, which every
    // caller here handles — the assertions are about what was dialled and what was sent.
    const outbox = ['220 local\r\n', '250-local\r\n250 AUTH PLAIN\r\n', '235 ok\r\n'];
    return Promise.resolve({
      read: () => Promise.resolve(outbox.shift()),
      write: (data: string) => {
        if (data.startsWith('AUTH PLAIN ')) auth.push(data.trim());
        return Promise.resolve();
      },
      startTls: () => Promise.resolve(),
      close: () => undefined,
    });
  };
  const send = async (url: string): Promise<void> => {
    const driver = createSmtpDriver({ url, from: FROM, allowInsecure: true, connect: connector });
    await caught(driver.send(messageFixture()));
  };

  await send('smtps://ada%40postly.test:p%40ss%2Fword@mail.example.test');
  await send('smtp://mail.example.test');

  expect(dialed).toEqual([
    { host: 'mail.example.test', port: 465, tls: true },
    { host: 'mail.example.test', port: 587, tls: false },
  ]);
  const payload = (auth[0] ?? '').slice('AUTH PLAIN '.length);
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)),
  );
  expect(decoded).toBe('\0ada@postly.test\0p@ss/word');
  // The credential-free url authenticates with nothing at all.
  expect(auth).toHaveLength(1);
});

test('a poolSize that opens no connection is refused at construction, never a silent deadlock', () => {
  const build = (poolSize: number): unknown =>
    thrown(() => createSmtpDriver({ url: 'smtp://mail.example.test:587', from: FROM, poolSize }));

  // 0 used to park every send on a slot that was never handed out: no error, no retry, and the
  // worker slot gone until a restart. Each of these is that same "no connection" value.
  for (const poolSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(codeOf(build(poolSize))).toBe('X_CONFIG_INVALID');
    expect(metaOf(build(poolSize))['poolSize']).toBe(poolSize);
  }
  // The valid boundary still builds — the check refuses `< 1`, not "small".
  expect(
    thrown(() => createSmtpDriver({ url: 'smtp://mail.example.test', from: FROM, poolSize: 1 })),
  ).toBeUndefined();
});

test('a url that is not SMTP is a config error at construction, not at the first send', () => {
  expect(
    codeOf(thrown(() => createSmtpDriver({ url: 'https://mail.example.test', from: FROM }))),
  ).toBe('X_CONFIG_INVALID');
  expect(codeOf(thrown(() => createSmtpDriver({ url: 'not a url', from: FROM })))).toBe(
    'X_CONFIG_INVALID',
  );
  expect(
    codeOf(thrown(() => createSmtpDriver({ url: 'smtp://mail.example.test', from: '  ' }))),
  ).toBe('X_CONFIG_INVALID');
});

// The deadline reaches `setTimeout(fn, timeoutMs)` in the conversation and in the socket, and
// `setTimeout(fn, NaN)` is `setTimeout(fn, 0)` — so a non-finite deadline does not disable itself,
// it fires on the next tick and every send fails "the server sent nothing for NaNms". Refused
// where `poolSize` already is: at construction, naming the argument an operator passes.
test('a non-finite timeout is refused at construction, like poolSize', () => {
  const error = thrown(() =>
    createSmtpDriver({ url: 'smtp://mail.test:587', from: FROM, timeoutMs: Number.NaN }),
  );
  expect(codeOf(error)).not.toContain('not an UltimateError');
  expect(isUltimateError(error) ? error.cause : '').toContain('timeoutMs');
});

test('a zero timeout is refused rather than expiring every read on the next tick', () => {
  const error = thrown(() =>
    createSmtpDriver({ url: 'smtp://mail.test:587', from: FROM, timeoutMs: 0 }),
  );
  expect(isUltimateError(error) ? error.cause : '').toContain('timeoutMs');
});
