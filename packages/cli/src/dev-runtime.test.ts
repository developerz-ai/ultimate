// The mail seam of the dev/production boot: which transport a process installs, and how it says
// so. The other services are covered by `cmd-dev.test.ts`, which boots them for real.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MailDriver } from '@ultimat3/mail';
import { createMemoryDriver, tryMailDriver } from '@ultimat3/mail';
import { describeMail, type RunningServices, startServices } from './dev-runtime';
import type { DevServices } from './dev-services';
import { resolveServices } from './dev-services';

const runtimeWith = (mail: MailDriver, mailDetail: string): RunningServices =>
  ({ mail, mailDetail }) as unknown as RunningServices;

/** Every embedded Postgres directory a boot created, removed once the process is done with it. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('describeMail', () => {
  test('a caught outbox reports as embedded, like the other bindings', () => {
    expect(describeMail(runtimeWith(createMemoryDriver(), 'caught in memory'))).toBe(
      'mail=embedded',
    );
  });

  test('a real transport names itself and the env key that selected it', () => {
    const smtp: MailDriver = { name: 'smtp', send: () => Promise.reject(new Error('unused')) };
    expect(describeMail(runtimeWith(smtp, 'SMTP_URL'))).toBe('mail=external(smtp via SMTP_URL)');
  });

  // The boot line is printed, logged and scraped. `SMTP_URL` holds a password, so the detail is
  // the key's name and never its value — this is the assertion that keeps it that way.
  test('the report carries the env key, never the credential behind it', () => {
    const smtp: MailDriver = { name: 'smtp', send: () => Promise.reject(new Error('unused')) };
    expect(describeMail(runtimeWith(smtp, 'SMTP_URL'))).not.toContain('@');
  });
});

describe('startServices', () => {
  /**
   * Selection runs before the queue, so a bad credential rejects without booting PGlite. That
   * ordering is the assertion: this test hands `startServices` a `DevServices` with no usable
   * state directory, and it must still reject on the environment alone. If the env stopped being
   * threaded through, or selection moved after `startQueue`, this would boot instead of throwing.
   */
  test('refuses two credentials before any service starts', async () => {
    const unusable = { stateDir: '/nonexistent/x-dev-should-never-be-read' } as DevServices;
    const failure = await startServices(unusable, {
      SMTP_URL: 'smtps://user:pass@mail.test:465',
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'Postly <no-reply@postly.test>',
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; cause?: string },
    );

    expect(failure?.code).toBe('X_CONFIG_INVALID');
    expect(failure?.cause).toContain('both set');
  });

  /**
   * The whole point of the task: a credential in the environment makes `mailDriver()` a real
   * transport, so `send()` reaches a server instead of an outbox nobody drains. Booted for real
   * because the ambient install is the thing under test — a fake `DevServices` would prove that
   * `selectMailDriver` returns an object, which is already covered in `@ultimat3/mail`.
   */
  test(
    'a credential in the environment installs the transport as the ambient driver',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'x-mail-boot-'));
      roots.push(root);
      const runtime = await startServices(resolveServices(root, {}), {
        SMTP_URL: 'smtps://user:pass@mail.postly.test:465',
        MAIL_FROM: 'Postly <no-reply@postly.test>',
      });
      try {
        // The ambient accessor, not the return value: `send()` resolves the driver through this.
        expect(tryMailDriver()?.name).toBe('smtp');
        expect(runtime.mail.name).toBe('smtp');
        expect(describeMail(runtime)).toBe('mail=external(smtp via SMTP_URL)');
      } finally {
        await runtime.stop();
      }
      // Released on stop, so the next process does not inherit a transport it never configured.
      expect(tryMailDriver()).toBeUndefined();
    },
    { timeout: 60_000 },
  );

  test(
    'no credential leaves the caught outbox in place',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'x-mail-boot-'));
      roots.push(root);
      const runtime = await startServices(resolveServices(root, {}), {});
      try {
        expect(tryMailDriver()?.name).toBe('memory');
        expect(describeMail(runtime)).toBe('mail=embedded');
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );
});
