// The exercise room's mail seam: every send delivered to memory, and only the observed call's
// kept. Asked at the send, in the sender's own async context — a timer's or another request's
// mail sent while the call awaits is somebody else's effect, never the primitive's.

import type { MailMessage } from '@ultimat3/mail';

export interface RoomMail extends Disposable {
  /** The observed call's messages since `clear()`, newest first — the `outbox()` order. */
  sent(): readonly MailMessage[];
  clear(): void;
}

/** Install a driver frame whose kept messages are those sent while `owns()` answers true. */
export async function roomMail(owns: () => boolean): Promise<RoomMail> {
  const { memoryMailDriver } = await import('@ultimat3/mail');
  // The installer is the `./adapter` subpath's, never the barrel's (slice 21).
  const { installMailDriver } = await import('@ultimat3/mail/adapter');
  const memory = memoryMailDriver();
  const kept: MailMessage[] = [];
  const release = installMailDriver({
    name: 'test',
    send: async (message) => {
      // Read before the first await: the send's own context, not whatever resumes it.
      const mine = owns();
      const result = await memory.send(message);
      if (mine) kept.unshift(message);
      return result;
    },
  });
  return {
    sent: () => [...kept],
    clear: () => {
      kept.length = 0;
      memory.clear();
    },
    [Symbol.dispose]: (): void => {
      release();
    },
  };
}
