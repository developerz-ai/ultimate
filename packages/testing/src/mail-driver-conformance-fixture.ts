// The three production mail transports, each built for real over its own injection seam — SMTP
// over a fake `SmtpStream`, Resend and SES over a fake `fetch` — so the conformance suite asks the
// shipped drivers themselves, and a wire-level case can read what each one actually sent.

import type { SmtpConnector, SmtpStream } from '@ultimat3/mail';
import { type MailFetch, resendMailDriver, sesMailDriver, smtpMailDriver } from '@ultimat3/mail';
import type { MailDriver } from '@ultimat3/mail/adapter';

export const FIXTURE_FROM = 'Postly <no-reply@postly.test>';

export interface SmtpProbe {
  readonly driver: MailDriver;
  /** One entry per dial: the command lines that session saw. */
  readonly sessions: string[][];
  /** The raw MIME each accepted `DATA` carried. */
  readonly bodies: string[];
}

/** One session's server half: greeting, EHLO, envelope, `DATA` framed by `\r\n.\r\n`. */
function fakeSession(lines: string[], bodies: string[]): SmtpStream {
  const replies: string[] = ['220 fake.test ESMTP\r\n'];
  let inData = false;
  let buffer = '';
  const answer = (line: string): string => {
    if (line.startsWith('EHLO')) return '250-fake.test\r\n250 SIZE 20000000\r\n';
    if (line === 'DATA') {
      inData = true;
      return '354 End data with <CR><LF>.<CR><LF>\r\n';
    }
    return line === 'QUIT' ? '221 2.0.0 Bye\r\n' : '250 2.0.0 Ok\r\n';
  };
  return {
    read: () => Promise.resolve(replies.shift()),
    write(chunk: string): Promise<void> {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf(inData ? '\r\n.\r\n' : '\r\n');
        if (end === -1) break;
        if (inData) {
          bodies.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          replies.push('250 2.0.0 Ok: queued\r\n');
          continue;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        lines.push(line);
        replies.push(answer(line));
      }
      return Promise.resolve();
    },
    startTls: () => Promise.resolve(),
    close: () => undefined,
  };
}

/** `smtps://`, so the session is secure from the first byte and no STARTTLS step is in the way. */
export function smtpProbe(): SmtpProbe {
  const sessions: string[][] = [];
  const bodies: string[] = [];
  const connect: SmtpConnector = () => {
    const lines: string[] = [];
    sessions.push(lines);
    return Promise.resolve(fakeSession(lines, bodies));
  };
  return {
    sessions,
    bodies,
    driver: smtpMailDriver({ url: 'smtps://fake.test:465', from: FIXTURE_FROM, connect }),
  };
}

export interface HttpRequestSeen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface HttpProbe {
  readonly driver: MailDriver;
  /** One entry per request. */
  readonly requests: HttpRequestSeen[];
}

const recording = (requests: HttpRequestSeen[], answer: () => Response): MailFetch => {
  return (url, init) => {
    requests.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Promise.resolve(answer());
  };
};

export function resendProbe(): HttpProbe {
  const requests: HttpRequestSeen[] = [];
  const fetch = recording(requests, () => Response.json({ id: 'resend_fake_id' }));
  return {
    requests,
    driver: resendMailDriver({ apiKey: 'resend_sk_conformance', from: FIXTURE_FROM, fetch }),
  };
}

export function sesProbe(): HttpProbe {
  const requests: HttpRequestSeen[] = [];
  const fetch = recording(requests, () => Response.json({ MessageId: '0102018f-ses-fake-id' }));
  return {
    requests,
    driver: sesMailDriver({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDCONFORMANCE', secretAccessKey: 'conformance-secret' },
      from: FIXTURE_FROM,
      fetch,
    }),
  };
}
