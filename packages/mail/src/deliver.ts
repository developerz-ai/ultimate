// Single responsibility: hand one rendered message to the installed transport — the ONE place a
// mail leaves the process, inline or from the queue — inside a client span, reported on core's
// instrumentation bus as `mail.deliver` (a recipient COUNT: addresses never ride an event).

import { instrument, subscribed, withSpan } from '@ultimat3/core';
import type { MailMessage, SendResult } from './driver';
import { envelopeRecipients, mailDriver } from './driver';

export async function deliverMail(message: MailMessage): Promise<SendResult> {
  const driver = mailDriver();
  const recipients = envelopeRecipients(message).length;
  const started = performance.now();
  try {
    const result = await withSpan('mail.deliver', () => driver.send(message), {
      kind: 'client',
      attributes: {
        'ultimate.mail.id': message.mailId,
        'ultimate.mail.transport': driver.name,
        'ultimate.mail.recipients': recipients,
      },
    });
    if (subscribed('mail.deliver')) {
      instrument('mail.deliver', {
        transport: driver.name,
        recipients,
        durationMs: performance.now() - started,
      });
    }
    return result;
  } catch (error) {
    if (subscribed('mail.deliver')) {
      instrument('mail.deliver', {
        transport: driver.name,
        recipients,
        durationMs: performance.now() - started,
        error,
      });
    }
    throw error;
  }
}
