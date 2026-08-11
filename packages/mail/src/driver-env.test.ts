// The selection seam: a credential picks its transport, two credentials are refused, and no
// credential catches in memory. These are the only tests that prove the shipped transports are
// reachable from a boot at all — everything else in the package tests them once constructed.

import { describe, expect, test } from 'bun:test';
import type { MailDriver } from './driver';
import { createMemoryDriver, isMemoryDriver } from './driver';
import { MAIL_ENV_KEYS, selectMailDriver } from './driver-env';

const FROM = 'Postly <no-reply@postly.test>';
const SMTP_URL = 'smtps://user:pass@mail.postly.test:465';

const thrown = (run: () => unknown): { code?: string; cause?: string; fix?: string } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; cause?: string; fix?: string };
  }
  throw new Error('expected selectMailDriver to throw');
};

describe('selectMailDriver', () => {
  test('SMTP_URL selects the smtp transport', () => {
    const selection = selectMailDriver({ SMTP_URL, MAIL_FROM: FROM });
    expect(selection.driver.name).toBe('smtp');
    expect(selection.detail).toBe('SMTP_URL');
    expect(isMemoryDriver(selection.driver)).toBe(false);
  });

  test('RESEND_API_KEY selects the resend transport', () => {
    const selection = selectMailDriver({ RESEND_API_KEY: 're_test_key', MAIL_FROM: FROM });
    expect(selection.driver.name).toBe('resend');
    expect(selection.detail).toBe('RESEND_API_KEY');
  });

  test('no credential catches in memory and says how to deliver', () => {
    const selection = selectMailDriver({});
    expect(isMemoryDriver(selection.driver)).toBe(true);
    expect(selection.detail).toContain('SMTP_URL');
    expect(selection.detail).toContain('RESEND_API_KEY');
  });

  // A blank value in a `.env` file is the same as an unset one everywhere else in the framework;
  // treating it as a credential would build a transport out of an empty string.
  test('a blank credential is an unset one', () => {
    expect(isMemoryDriver(selectMailDriver({ SMTP_URL: '   ' }).driver)).toBe(true);
    expect(isMemoryDriver(selectMailDriver({ RESEND_API_KEY: '' }).driver)).toBe(true);
  });

  test('both credentials are refused rather than one silently winning', () => {
    const error = thrown(() =>
      selectMailDriver({ SMTP_URL, RESEND_API_KEY: 're_test_key', MAIL_FROM: FROM }),
    );
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain('SMTP_URL and RESEND_API_KEY are both set');
    expect(error.fix).toContain('unset one');
  });

  test('a transport without MAIL_FROM names the missing key, not the driver internals', () => {
    const error = thrown(() => selectMailDriver({ SMTP_URL }));
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain('MAIL_FROM is unset');
    expect(error.fix).toContain('MAIL_FROM=');
  });

  test('resend without MAIL_FROM is refused the same way', () => {
    const error = thrown(() => selectMailDriver({ RESEND_API_KEY: 're_test_key' }));
    expect(error.cause).toContain('MAIL_FROM is unset');
    expect(error.cause).toContain('RESEND_API_KEY');
  });

  test('MAIL_POOL_SIZE reaches the smtp driver', () => {
    expect(selectMailDriver({ SMTP_URL, MAIL_FROM: FROM, MAIL_POOL_SIZE: '2' }).driver.name).toBe(
      'smtp',
    );
  });

  test.each([['nope'], ['0'], ['2.5'], ['-1']])(
    'MAIL_POOL_SIZE=%p is refused at the env boundary',
    (raw) => {
      const error = thrown(() =>
        selectMailDriver({ SMTP_URL, MAIL_FROM: FROM, MAIL_POOL_SIZE: raw }),
      );
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.cause).toContain('MAIL_POOL_SIZE');
      // The operator set a string in a file; a cause reading "poolSize: NaN" names nothing they own.
      expect(error.cause).not.toContain('NaN');
    },
  );

  // The keys are documented in the wiki and read by the CLI's service resolution. A key added
  // here without being added there is a key nothing tells an operator about.
  test('the read keys are exactly the declared ones', () => {
    expect([...MAIL_ENV_KEYS]).toEqual([
      'SMTP_URL',
      'RESEND_API_KEY',
      'MAIL_FROM',
      'MAIL_POOL_SIZE',
    ]);
  });

  test('a bad SMTP_URL still fails at selection, not at first send', () => {
    expect(thrown(() => selectMailDriver({ SMTP_URL: 'https://nope', MAIL_FROM: FROM })).code).toBe(
      'X_CONFIG_INVALID',
    );
  });
});

describe('isMemoryDriver', () => {
  // The guard decides whether a host reads `outbox()`. Narrowing on the name alone would let a
  // transport that happens to be called "memory" reach a method it does not have.
  test('a look-alike without an outbox is not a memory driver', () => {
    const impostor: MailDriver = {
      name: 'memory',
      send: () => Promise.reject(new Error('unused')),
    };
    expect(isMemoryDriver(impostor)).toBe(false);
  });

  test('the real one is', () => {
    expect(isMemoryDriver(createMemoryDriver())).toBe(true);
  });
});

/**
 * The greeting and EHLO of a server that offers no STARTTLS, and nothing more — the conversation
 * under test stops there on purpose. `Bun.listen` on loopback is allowed: the sealed test network
 * covers `fetch` only, and a transport that has only ever met a fake stream has not been proven
 * to dial anything.
 */
function startPlaintextSmtp(): {
  readonly port: number;
  readonly commands: string[];
  stop(): void;
} {
  const commands: string[] = [];
  const decoder = new TextDecoder();
  const buffers = new Map<unknown, string>();
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        buffers.set(socket, '');
        socket.write('220 local.test ESMTP\r\n');
      },
      close(socket) {
        buffers.delete(socket);
      },
      data(socket, chunk) {
        let buffer = (buffers.get(socket) ?? '') + decoder.decode(chunk);
        for (;;) {
          const eol = buffer.indexOf('\r\n');
          if (eol === -1) break;
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          commands.push(line);
          // No STARTTLS in the capability list: the driver must refuse rather than downgrade.
          if (line.startsWith('EHLO')) socket.write('250-local.test\r\n250 SIZE 20000000\r\n');
          else if (line === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else socket.write('502 5.5.2 Command not implemented\r\n');
        }
        buffers.set(socket, buffer);
      },
    },
  });
  return { port: listener.port, commands, stop: () => listener.stop(true) };
}

// The proof that the selection is a transport and not a shape: it opens a socket to the address
// the env key named and speaks SMTP on it. Nothing else in the package covers env → the wire.
test('the env-selected transport dials for real and refuses to send in the clear', async () => {
  const server = startPlaintextSmtp();
  try {
    const selection = selectMailDriver({
      SMTP_URL: `smtp://127.0.0.1:${server.port}`,
      MAIL_FROM: FROM,
    });
    expect(selection.driver.name).toBe('smtp');

    const failure = await selection.driver
      .send({
        mailId: 'welcome',
        to: ['ada@example.test'],
        subject: 'Welcome',
        html: '<p>hi</p>',
        text: 'hi',
        locale: 'en',
        tz: 'UTC',
      })
      .then(
        () => undefined,
        (error: unknown) => error as { code?: string; fix?: string },
      );

    // It got far enough to greet the server and read its capabilities — a driver that never
    // connected could not have produced this command list.
    expect(server.commands.some((line) => line.startsWith('EHLO'))).toBe(true);
    expect(failure?.code).toBe('X_MAIL_SEND_FAILED');
    // The fix names the env key the operator set, which is the thing they can actually change.
    expect(failure?.fix).toContain('SMTP_URL');
    expect(failure?.fix).toContain('smtps://');
  } finally {
    server.stop();
  }
});
