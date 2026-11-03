// How the services name themselves: the mail and CDN descriptions, the rendered label beside the
// machine status. Split out of `runtime-services.test.ts` at the file ceiling.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import type { PurgeDriver } from '@ultimat3/cache';
import { noopPurgeDriver } from '@ultimat3/cache';
import { NotImplementedError } from '@ultimat3/core';
import type { MailDriver } from '@ultimat3/mail';
import { memoryMailDriver } from '@ultimat3/mail';
import { selectTransport } from '@ultimat3/realtime/server';
import { eventsBinding } from './runtime-bindings';
import {
  cdnLabel,
  describeCdn,
  describeMail,
  mailLabel,
  type RunningServices,
} from './runtime-services';

const runtimeWith = (mail: MailDriver, mailDetail: string): RunningServices =>
  ({ mail, mailDetail }) as unknown as RunningServices;

const cdnRuntimeWith = (purge: PurgeDriver, purgeDetail: string): RunningServices =>
  ({ purge, purgeDetail }) as unknown as RunningServices;

/**
 * `describeMail` reads `name` and `mailDetail`, never `send` — so this one exists only to satisfy
 * `MailDriver`, and it refuses with a code carrying a runnable fix. Never a bare Error, tests
 * included: a throw without a code and a fix is not an instruction to whoever reaches it.
 */
const fakeSmtp = (): MailDriver => ({
  name: 'smtp',
  send: (): Promise<never> =>
    Promise.reject(
      new NotImplementedError({
        cause: 'sending through the describeMail fixture transport is not implemented',
        fix: 'x dev   # boots the transport SMTP_URL selects, which does send',
      }),
    ),
});

describe('describeMail', () => {
  test('a caught outbox reports as embedded, like the other bindings', () => {
    expect(describeMail(runtimeWith(memoryMailDriver(), 'caught in memory'))).toBe('mail=embedded');
  });

  test('a real transport names itself and the env key that selected it', () => {
    expect(describeMail(runtimeWith(fakeSmtp(), 'SMTP_URL'))).toBe(
      'mail=external(smtp via SMTP_URL)',
    );
  });

  // The boot line is printed, logged and scraped. `SMTP_URL` holds a password, so the detail is
  // the key's name and never its value — this is the assertion that keeps it that way.
  test('the report carries the env key, never the credential behind it', () => {
    expect(describeMail(runtimeWith(fakeSmtp(), 'SMTP_URL'))).not.toContain('@');
  });
});

/**
 * The status value `--json` carries and the label the boot line prints are two surfaces of one
 * fact, and `wiki/Configuration.md` quotes both — so a catalog edit that moves the printed line
 * without moving the documented status has to fail here rather than in a script that parses it.
 */
describe('the rendered label and the machine status', () => {
  test('agree for every mail case', () => {
    const memory = runtimeWith(memoryMailDriver(), 'caught in memory');
    expect(mailLabel(memory)).toBe(describeMail(memory));
    const smtp = runtimeWith(fakeSmtp(), 'SMTP_URL');
    expect(mailLabel(smtp)).toBe(describeMail(smtp));
  });

  test('agree for every cdn case', () => {
    const none = cdnRuntimeWith(noopPurgeDriver(), 'no edge');
    expect(cdnLabel(none)).toBe(describeCdn(none));
    const fastly = cdnRuntimeWith(
      { name: 'fastly', purge: () => Promise.resolve([]), purgeAll: () => Promise.resolve() },
      'FASTLY_API_TOKEN',
    );
    expect(cdnLabel(fastly)).toBe(describeCdn(fastly));
  });
});

/**
 * Two readers of one `realtime` section: `eventsBinding` for the boot line an operator reads, and
 * `selectTransport` for the object the process actually fans out on. A boot that printed
 * `events=external` while running the in-process transport would be the worst of both, so the two
 * answers are pinned against each other rather than trusted to stay in step.
 */
describe('the reported binding and the selected transport', () => {
  // One config handed to both readers, as `startServices` hands its loaded section to both.
  const memory = { enabled: true, transport: 'memory', urlEnv: undefined } as const;
  const nats = { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' } as const;

  test('agree that no url is embedded', () => {
    expect(eventsBinding({}, memory).mode).toBe(selectTransport({}, memory).mode);
  });

  test('agree that a url — even a padded one — is external', () => {
    const env = { NATS_URL: '  nats://bus.test:4222  ' };
    expect(eventsBinding(env, nats).mode).toBe(selectTransport(env, nats).mode);
    expect(selectTransport(env, nats).mode).toBe('external');
  });
});

describe('describeCdn', () => {
  // There is no embedded CDN. Reporting one would read as a fifth service this boot started.
  test('no credential reports no edge, not an embedded one', () => {
    expect(describeCdn(cdnRuntimeWith(noopPurgeDriver(), 'no edge'))).toBe('cdn=none');
  });

  test('a real driver names itself and the env key that selected it', () => {
    const fastly: PurgeDriver = {
      name: 'fastly',
      purge: () => Promise.resolve([]),
      purgeAll: () => Promise.resolve(),
    };
    expect(describeCdn(cdnRuntimeWith(fastly, 'FASTLY_API_TOKEN'))).toBe(
      'cdn=external(fastly via FASTLY_API_TOKEN)',
    );
  });
});
