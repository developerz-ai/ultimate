// The selection seam: a credential picks its transport, two credentials are refused, and no
// credential catches in memory. These are the only tests that prove the shipped transports are
// reachable from a boot at all — everything else in the package tests them once constructed.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { MailDriver, MailMessage, MemoryMailDriver } from './driver';
import { createMemoryDriver, isMemoryDriver } from './driver';
import { MAIL_ENV_KEYS, selectMailDriver } from './driver-env';
import { driverUnavailable } from './errors';

const FROM = 'Postly <no-reply@postly.test>';
const SMTP_URL = 'smtps://user:pass@mail.postly.test:465';

/** The thrown error itself, so a test can assert on `code`, `cause` and `fix` together. */
const thrown = (run: () => unknown): UltimateError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  // `expect.unreachable` fails through the runner, so the caller sees its own assertion rather
  // than a stack from inside this helper — and a bare throw here would carry no code and no fix.
  return expect.unreachable('expected selectMailDriver to refuse with an UltimateError');
};

/** Every `MemoryMailDriver` member, optional and removable, so a case can drop exactly one. */
type MemoryMembers = { -readonly [K in keyof MemoryMailDriver]?: MemoryMailDriver[K] };

/**
 * A driver that answers to `memory` and holds exactly the members a case grants it. The refusal
 * it sends is coded like any other driver refusal: nothing calls it, and a bare `Error` here would
 * still be the one shape this package forbids.
 */
function memoryLike(members: MemoryMembers): MailDriver {
  const driver: MailDriver & MemoryMembers = {
    name: 'memory',
    send: () =>
      Promise.reject(driverUnavailable('a look-alike driver in this test cannot deliver')),
    ...members,
  };
  return driver;
}

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

/**
 * The highest-severity thing this file guards. With no credential the selection used to answer the
 * MEMORY driver in every environment, so a deployment that configured no transport reported
 * `accepted` for mail that never left the process: password resets, receipts and invitations all
 * "sent", none delivered, no error anywhere. Outside development the driver now refuses on the
 * send that needs it.
 */
describe('a deployment with no mail credential', () => {
  const message: MailMessage = {
    mailId: 'reset-password',
    to: ['ada@example.test'],
    subject: 'Reset your password',
    html: '<p>reset</p>',
    text: 'reset',
    locale: 'en',
    tz: 'UTC',
  };

  const refusal = async (env: Record<string, string>): Promise<UltimateError> => {
    const selection = selectMailDriver(env);
    expect(isMemoryDriver(selection.driver)).toBe(false);
    const failure = await selection.driver.send(message).then(
      (result): unknown => result,
      (error: unknown) => error,
    );
    if (failure instanceof UltimateError) return failure;
    return expect.unreachable('expected the send to be refused, not accepted');
  };

  test.each(['development', 'test'])('%s still catches in memory', (environment) => {
    expect(isMemoryDriver(selectMailDriver({ ULTIMATE_ENV: environment }).driver)).toBe(true);
  });

  test.each(['staging', 'production'])(
    '%s refuses the send instead of reporting accepted',
    async (environment) => {
      const error = await refusal({ ULTIMATE_ENV: environment });
      expect(error.code).toBe('X_MAIL_CREDENTIAL_MISSING');
      expect(error.cause).toContain(environment);
      // The two variables an operator can actually set, in the fix, not in prose somewhere else.
      expect(error.fix).toContain('SMTP_URL');
      expect(error.fix).toContain('RESEND_API_KEY');
    },
  );

  // The env the shipped artifact actually boots with: `docker/Dockerfile` sets `NODE_ENV=production`
  // and nothing sets `ULTIMATE_ENV`. A refusal that only armed on `ULTIMATE_ENV` would have left
  // every container this framework builds on the memory driver, which is the whole bug.
  test('the shipped image environment arms it: NODE_ENV=production, no ULTIMATE_ENV', async () => {
    expect((await refusal({ NODE_ENV: 'production' })).code).toBe('X_MAIL_CREDENTIAL_MISSING');
  });

  // A blank credential is an unset one everywhere else in this file; it must not become a transport
  // here either, and it must not fall back to the silent memory driver in production.
  test('a blank credential in production is refused, not caught', async () => {
    expect((await refusal({ ULTIMATE_ENV: 'production', SMTP_URL: '  ' })).code).toBe(
      'X_MAIL_CREDENTIAL_MISSING',
    );
  });

  test('the boot line names both keys and never a credential', () => {
    const detail = selectMailDriver({ ULTIMATE_ENV: 'production' }).detail;
    expect(detail).toContain('SMTP_URL');
    expect(detail).toContain('RESEND_API_KEY');
    expect(detail).toContain('production');
  });
});

describe('isMemoryDriver', () => {
  // The guard decides whether a host reads `outbox()`. Narrowing on the name alone would let a
  // transport that happens to be called "memory" reach a method it does not have.
  test('a look-alike without an outbox is not a memory driver', () => {
    expect(isMemoryDriver(memoryLike({}))).toBe(false);
  });

  // The predicate promises the whole `MemoryMailDriver` interface, so it has to check the whole
  // interface: `outbox()` is what the `/_x` panel reaches first, not all it reaches. A partial
  // look-alike that passed here would type-check its way into `sent`, `lastTo()` and `clear()`.
  test('a look-alike with an outbox and nothing else is refused', () => {
    expect(isMemoryDriver(memoryLike({ outbox: () => [] }))).toBe(false);
  });

  test.each(['sent', 'outbox', 'lastTo', 'clear'] as const)(
    'a memory driver missing only %s is refused',
    (missing) => {
      const members: MemoryMembers = { ...createMemoryDriver() };
      delete members[missing];
      expect(isMemoryDriver(memoryLike(members))).toBe(false);
    },
  );

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
