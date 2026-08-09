// Tests for the production stream over a real loopback socket: chunks queue in order, a closed
// connection reads as EOF instead of hanging, and the STARTTLS upgrade is handed to the runtime in
// the shape it accepts. A completed TLS handshake needs a certificate authority and is not tested
// here — `driver-smtp.test.ts` covers the plaintext path end to end.

import { expect, test } from 'bun:test';
import { bunSmtpStream } from './smtp-socket';

interface Echo {
  readonly port: number;
  readonly received: string[];
  hangUp(): void;
  stop(): void;
}

/**
 * A server that greets, answers every line with `250 ok`, and can drop the connection on demand.
 * Answering is what makes the tests deterministic: reading the reply proves the server already
 * processed what was written to it, with no sleep to race against.
 */
function startEcho(): Echo {
  const received: string[] = [];
  const decoder = new TextDecoder();
  const sockets: { write(data: string): void; end(): void }[] = [];

  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        sockets.push(socket);
        socket.write('220 local.test ESMTP\r\n');
      },
      data(socket, chunk) {
        received.push(decoder.decode(chunk));
        socket.write('250 ok\r\n');
      },
    },
  });

  return {
    port: listener.port,
    received,
    hangUp: () => {
      for (const socket of sockets) socket.end();
    },
    stop: () => listener.stop(true),
  };
}

const target = (port: number): { host: string; port: number; tls: boolean; timeoutMs: number } => ({
  host: '127.0.0.1',
  port,
  tls: false,
  timeoutMs: 2_000,
});

test('chunks arrive in the order the server wrote them', async () => {
  const server = startEcho();
  try {
    const stream = await bunSmtpStream(target(server.port));

    expect(await stream.read()).toBe('220 local.test ESMTP\r\n');
    await stream.write('EHLO postly.test\r\n');

    expect(await stream.read()).toBe('250 ok\r\n');
    expect(server.received.join('')).toBe('EHLO postly.test\r\n');

    stream.close();
  } finally {
    server.stop();
  }
});

test('a server that hangs up reads as EOF rather than parking the reader forever', async () => {
  const server = startEcho();
  try {
    const stream = await bunSmtpStream(target(server.port));
    expect(await stream.read()).toContain('220');

    // The reader parks first, so this exercises the waiting path, not the buffered one.
    const pending = stream.read();
    server.hangUp();

    expect(await pending).toBeUndefined();
    expect(await stream.read()).toBeUndefined();
  } finally {
    server.stop();
  }
});

test('the STARTTLS upgrade is handed to the runtime in the shape it accepts', async () => {
  const server = startEcho();
  try {
    const stream = await bunSmtpStream(target(server.port));
    expect(await stream.read()).toContain('220');

    // `upgradeTLS` validates its options and throws on a wrong shape ("Expected \"socket\"
    // option"), so a clean resolve here is what proves the call site, not the handshake.
    await stream.startTls();

    stream.close();
  } finally {
    server.stop();
  }
});

test('a connection refused by nobody listening rejects instead of resolving a dead stream', async () => {
  const server = startEcho();
  const port = server.port;
  server.stop();

  const opened = await bunSmtpStream(target(port)).then(
    () => 'resolved',
    () => 'rejected',
  );

  expect(opened).toBe('rejected');
});
