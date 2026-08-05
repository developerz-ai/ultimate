// The `mail` fixture: an in-memory outbox, plus the one failure a mail test actually needs.
//
// `mail.failOnce(nudgeEmail)` is how a job test proves that only the failed step retried. It is
// a transport failure rather than a thrown stub because a stub would bypass rendering, and a
// mail that fails to render is the bug this catches most often.

import type { MailDriver, MailMessage, SendResult, SentMail } from '@ultimat3/mail';

/** A `defineMail()` handle, or its id. Both read naturally at a call site. */
export type MailRef = string | { readonly id: string };

export interface TestMail {
  /** Newest first, so an assertion does not index backwards. */
  outbox(): readonly SentMail[];
  lastTo(address: string): SentMail | undefined;
  /** The next send of this mail fails, once. Every later send succeeds. */
  failOnce(mail: MailRef): void;
  clear(): void;
}

const idOf = (mail: MailRef): string => (typeof mail === 'string' ? mail : mail.id);

export async function createTestMail(): Promise<TestMail> {
  const { createMemoryDriver, driverUnavailable, setMailDriver } = await import('@ultimat3/mail');
  const memory = createMemoryDriver();
  const failuresLeft = new Map<string, number>();

  const driver: MailDriver = {
    name: 'test',
    send(message: MailMessage): Promise<SendResult> {
      const left = failuresLeft.get(message.mailId) ?? 0;
      if (left === 0) return memory.send(message);
      failuresLeft.set(message.mailId, left - 1);
      return Promise.reject(
        driverUnavailable(`mail.failOnce() failed "${message.mailId}" on purpose`),
      );
    },
  };
  setMailDriver(driver);

  return {
    outbox: () => memory.outbox(),
    lastTo: (address) => memory.lastTo(address),
    failOnce: (mail) => {
      const id = idOf(mail);
      failuresLeft.set(id, (failuresLeft.get(id) ?? 0) + 1);
    },
    clear: () => {
      memory.clear();
      failuresLeft.clear();
    },
  };
}
