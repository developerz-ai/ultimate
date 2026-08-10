// Single responsibility: the SMTP conversation — greeting, EHLO, STARTTLS, AUTH, envelope, DATA.
// It talks to an `SmtpStream`, never to a socket, so the whole protocol runs in a test with no
// network. Every refusal becomes `X_MAIL_SEND_FAILED` naming the stage and the server's own reply.

import { base64Utf8 } from './base64';
import { type MailError, type SendStage, sendFailed } from './errors';
import {
  authPlain,
  createReplyParser,
  dotStuff,
  isPositive,
  isTransient,
  parseCapabilities,
  replySummary,
  type SmtpCapabilities,
  type SmtpReply,
} from './smtp-protocol';

/** The byte pipe the conversation runs over. `smtp-socket.ts` implements it over `Bun.connect`. */
export interface SmtpStream {
  /** The next chunk the server sent, or `undefined` once it closed the connection. */
  read(): Promise<string | undefined>;
  write(data: string): Promise<void>;
  /** STARTTLS: negotiate TLS in place. Everything read or written after this is encrypted. */
  startTls(): Promise<void>;
  close(): void;
}

export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (`smtps://`, usually port 465). `false` starts the session in the clear. */
  readonly tls: boolean;
  readonly timeoutMs: number;
}

export type SmtpConnector = (target: SmtpTarget) => Promise<SmtpStream>;

export interface SmtpEnvelope {
  /** The bare addr-spec for `MAIL FROM`, never a `Name <addr>` display form. */
  readonly from: string;
  readonly recipients: readonly string[];
  /** The MIME message. Dot-stuffing and the terminator belong to this module. */
  readonly data: string;
}

export interface SmtpSessionOptions {
  /** The `EHLO` argument. A real name the receiving server can resolve, not `localhost`. */
  readonly clientName: string;
  /** True when the socket is already TLS, so STARTTLS is neither needed nor offered. */
  readonly secure: boolean;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /** Send — and authenticate — over a cleartext channel. Off by default, for obvious reasons. */
  readonly allowInsecure: boolean;
  readonly timeoutMs: number;
}

/** The goodbye is not worth the read deadline the rest of the conversation gets. */
const QUIT_TIMEOUT_MS = 5_000;

// Keyed by `SendStage`, so a stage that is added to the union and forgotten here is a lookup that
// falls back rather than a silent typo. `Partial` because `connect` and `request` never reach a
// server reply: one belongs to the socket and the other to the HTTPS transport.
const FIXES: Readonly<Partial<Record<SendStage, string>>> = {
  greeting: 'correct the host and port in SMTP_URL — the server did not open with 220',
  ehlo: 'point SMTP_URL at an ESMTP server (submission on 587, implicit TLS on 465)',
  reply: 'point SMTP_URL at the SMTP port itself — a proxy or an HTTP port answers like this',
  tls: 'fix the certificate on the implicit-TLS port, or use smtp://host:587 and STARTTLS',
  starttls: 'set SMTP_URL in .env to smtps://host:465',
  auth: 'set SMTP_URL in .env to smtps://user:password@host:465 with a valid user and password',
  from: 'set mail.from in app.config.ts to an address this server is willing to relay for',
  recipient: 'the reply above names the address the server refused — correct or drop it',
  data: 'the reply above says why the body was refused (size, content or policy)',
  quit: 'nothing to fix: the message was already accepted before the goodbye failed',
};

const refused = (stage: SendStage, reply: SmtpReply): MailError =>
  sendFailed({
    driver: 'smtp',
    stage,
    detail: replySummary(reply),
    status: reply.code,
    retryable: isTransient(reply.code),
    fix: FIXES[stage] ?? 'run x doctor --json and check the mail section',
  });

/** Reads whole replies off a chunked stream, with a deadline on every one of them. */
class Conversation {
  private readonly parser = createReplyParser();
  private readonly pending: SmtpReply[] = [];

  constructor(
    private readonly stream: SmtpStream,
    private readonly timeoutMs: number,
  ) {}

  /** Sends one command line and reads the reply it expects. The line is never logged. */
  async say(stage: SendStage, line: string, wanted: (code: number) => boolean): Promise<SmtpReply> {
    await this.stream.write(`${line}\r\n`);
    return this.expect(stage, wanted);
  }

  async expect(stage: SendStage, wanted: (code: number) => boolean): Promise<SmtpReply> {
    const reply = await this.next(stage);
    if (!wanted(reply.code)) throw refused(stage, reply);
    return reply;
  }

  /**
   * Waits for the `221` so the server records a clean close instead of an aborted transaction —
   * but on a short leash, since the message is already accepted and a rude server that never
   * answers must not add its own delay to every send. Failures here are deliberately swallowed.
   */
  async quit(): Promise<void> {
    await this.stream.write('QUIT\r\n').catch(() => undefined);
    await this.next('quit', Math.min(this.timeoutMs, QUIT_TIMEOUT_MS)).catch(() => undefined);
  }

  private async next(stage: SendStage, timeoutMs = this.timeoutMs): Promise<SmtpReply> {
    for (;;) {
      const ready = this.pending.shift();
      if (ready !== undefined) return ready;
      this.pending.push(...this.parser.push(await this.chunk(stage, timeoutMs)));
    }
  }

  private async chunk(stage: SendStage, timeoutMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          sendFailed({
            driver: 'smtp',
            stage,
            detail: `the server sent nothing for ${timeoutMs}ms, so the read deadline expired`,
            retryable: true,
            fix: 'pass timeoutMs: 60_000 to createSmtpDriver() in app.config.ts',
          }),
        );
      }, timeoutMs);
    });
    try {
      const chunk = await Promise.race([this.stream.read(), expired]);
      if (chunk === undefined) {
        throw sendFailed({
          driver: 'smtp',
          stage,
          detail:
            'the server closed the connection mid-conversation, which is usually it ' +
            'rate-limiting the sessions it keeps open at once',
          retryable: true,
          fix: 'pass poolSize: 1 to createSmtpDriver() in app.config.ts',
        });
      }
      return chunk;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * One message, one connection. Returns the server's final `DATA` reply — the receipt an operator
 * needs when the recipient says the mail never arrived.
 */
export async function smtpDeliver(
  stream: SmtpStream,
  envelope: SmtpEnvelope,
  options: SmtpSessionOptions,
): Promise<SmtpReply> {
  const talk = new Conversation(stream, options.timeoutMs);
  await talk.expect('greeting', (code) => code === 220);

  const greet = async (): Promise<SmtpCapabilities> =>
    parseCapabilities(await talk.say('ehlo', `EHLO ${options.clientName}`, isPositive));

  let capabilities = await greet();
  let secure = options.secure;

  if (!secure && capabilities.starttls) {
    await talk.say('starttls', 'STARTTLS', (code) => code === 220);
    await stream.startTls();
    // Capabilities before TLS are not the capabilities after it: most servers only advertise AUTH
    // once the channel is encrypted, and a cleartext EHLO can be stripped in flight anyway.
    capabilities = await greet();
    secure = true;
  }

  if (!secure && !options.allowInsecure) {
    throw sendFailed({
      driver: 'smtp',
      stage: 'starttls',
      detail:
        'the server does not advertise STARTTLS and the connection is not already TLS; ' +
        'allowInsecure: true on createSmtpDriver() would send this in the clear instead',
      retryable: false,
      fix: FIXES['starttls'] ?? 'set SMTP_URL in .env to smtps://host:465',
    });
  }

  if (options.user !== undefined) await authenticate(talk, capabilities, options);

  await talk.say('from', `MAIL FROM:<${envelope.from}>`, isPositive);
  for (const recipient of envelope.recipients) {
    // Fail closed on any refusal: delivering to three of four addresses and reporting success is
    // the one outcome the caller cannot detect.
    await talk.say('recipient', `RCPT TO:<${recipient}>`, isPositive);
  }

  await talk.say('data', 'DATA', (code) => code === 354);
  const body = dotStuff(envelope.data).replace(/\r\n$/, '');
  const accepted = await talk.say('data', `${body}\r\n.`, isPositive);
  await talk.quit();
  return accepted;
}

async function authenticate(
  talk: Conversation,
  capabilities: SmtpCapabilities,
  options: SmtpSessionOptions,
): Promise<void> {
  const user = options.user ?? '';
  const password = options.password ?? '';
  const mechanisms = capabilities.authMechanisms;

  if (mechanisms.includes('PLAIN')) {
    await talk.say('auth', `AUTH PLAIN ${authPlain(user, password)}`, (code) => code === 235);
    return;
  }
  if (mechanisms.includes('LOGIN')) {
    await talk.say('auth', 'AUTH LOGIN', (code) => code === 334);
    await talk.say('auth', base64Utf8(user), (code) => code === 334);
    await talk.say('auth', base64Utf8(password), (code) => code === 235);
    return;
  }
  throw sendFailed({
    driver: 'smtp',
    stage: 'auth',
    detail: `the server offers no mechanism this client speaks (offered: ${
      mechanisms.join(', ') || 'none'
    })`,
    retryable: false,
    fix: 'drop user:password from SMTP_URL if the server wants none, or enable AUTH PLAIN on it',
  });
}
