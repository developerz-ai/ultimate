// A provider's connect URL is its access token. It reaches this package from a resolver or from
// the environment, a launcher repeats it in the error it throws, and that error's cause is written
// to the dead-letter row and printed by `x jobs show`. So the token appears in no error field, no
// log line and no artifact — and the host still does, because a reader has to know which endpoint.

import { describe, expect, test } from 'bun:test';
import { createContext, createLogger } from '@ultimat3/core';
import type { JobRunArgs, StepApi } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import type { StorageDriver, StorageObject } from '@ultimat3/storage';
import { fakeCdpLauncher } from './cdp-fake';
import type { CdpLauncherLike } from './cdp-port';
import { testClock } from './clock';
import { remoteBrowser } from './driver-cdp';
import { fakeBrowser } from './driver-fake';
import { cdpAttachFailed } from './error-throws';
import type { ScrapeDefinition } from './scrape';
import { runScrape } from './scrape-run';
import { endpointLabel, urlSecretValues } from './url-secrets';

const TOKEN = 'tok_live_9f8e7d6c5b4a3210';
const CDP_URL = `wss://connect.provider.test:8443/chrome?token=${TOKEN}&region=eu`;
const EXIT = 'http://zone-res:pr0xy-p4ssw0rd@exit-7.test:8080';

/** A launcher that fails the way a real one does: by repeating the URL it was handed. */
const refusing: CdpLauncherLike = {
  connect: (options) =>
    Promise.reject(
      new Error(`Unexpected server response: 401 for ${String(options['browserWSEndpoint'])}`),
    ),
};

const everythingIn = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof Error
      ? { ...inner, message: inner.message, stack: inner.stack, cause: inner.cause }
      : inner,
  );

interface Captured {
  readonly lines: string[];
  readonly artifacts: Map<string, string>;
  readonly storage: StorageDriver;
  readonly args: JobRunArgs<Record<string, never>>;
}

const capture = (): Captured => {
  const lines: string[] = [];
  const artifacts = new Map<string, string>();
  const object = (key: string): StorageObject => ({
    key,
    size: 0,
    contentType: 'text/html',
    etag: 'e',
    lastModified: new Date(0),
  });
  const unsupported = (what: string) => (): never =>
    expect.unreachable(`this fake storage driver does not implement ${what}`);
  const storage: StorageDriver = {
    name: 'fake',
    put(key, body) {
      artifacts.set(
        key,
        typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array),
      );
      return Promise.resolve(object(key));
    },
    get: unsupported('get'),
    stat: unsupported('stat'),
    delete: unsupported('delete'),
    stream: unsupported('stream'),
    copy: unsupported('copy'),
    exists: unsupported('exists'),
    list: unsupported('list'),
    signedUrl: unsupported('signedUrl'),
  };
  return {
    lines,
    artifacts,
    storage,
    args: {
      input: {},
      step: {
        run: <T>(_name: string, fn: () => Promise<T> | T) => Promise.resolve(fn()),
      } as unknown as StepApi,
      ctx: createContext({
        logger: createLogger({ level: 'debug', writer: (line) => lines.push(line) }),
      }),
      attempt: 1,
      finalAttempt: false,
      progress: () => undefined,
      jobId: 'job-1',
      runId: 'run-1',
    },
  };
};

const define = (
  over: Partial<ScrapeDefinition<Record<string, never>, { id: string }>>,
): ScrapeDefinition<Record<string, never>, { id: string }> => ({
  name: 'orders',
  input: t.object({}),
  extract: t.object({ id: t.string }),
  idempotencyKey: () => 'orders',
  tenant: 'none',
  allowHosts: ['shop.test'],
  robots: { ignore: 'a fake browser: there is no origin to ask' },
  clock: testClock(),
  run: () => Promise.resolve([]),
  ...over,
});

describe('unit · a resolver URL with a token in its query fails to attach', () => {
  test('the token is in no error field and no log line; scheme and host are in the cause', async () => {
    const captured = capture();
    let thrown: unknown;
    try {
      await runScrape(
        define({
          driver: remoteBrowser({
            launcher: refusing,
            cdpUrl: () => Promise.resolve({ cdpUrl: CDP_URL }),
          }),
        }),
        captured.args,
      );
    } catch (caught) {
      thrown = caught;
    }
    const error = thrown as { code?: string; cause?: string; meta?: unknown; message?: string };
    expect(error.code).toBe('X_SCRAPE_CDP_ATTACH_FAILED');
    expect(error.cause).toContain('wss://connect.provider.test:8443');
    expect(error.cause).toContain('401');
    expect(error.meta).toEqual({ cdpUrl: 'wss://connect.provider.test:8443' });
    const everything = `${everythingIn(thrown)}\n${String(error.message)}\n${captured.lines.join('\n')}`;
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('/chrome?token');
  });

  test('a FIXED cdpUrl is treated the same — an env var holds the same token', () => {
    const error = cdpAttachFailed(CDP_URL, new Error(`401 for ${CDP_URL}`));
    expect(everythingIn(error)).not.toContain(TOKEN);
    expect(error.cause).toContain('wss://connect.provider.test:8443');
  });

  test('a launcher that quotes only PART of the URL is redacted too', () => {
    const error = cdpAttachFailed(CDP_URL, new Error(`GET /chrome?token=${TOKEN}&region=eu 401`));
    expect(error.cause).not.toContain(TOKEN);
    const justTheToken = cdpAttachFailed(CDP_URL, new Error(`bad token ${TOKEN}`));
    expect(justTheToken.cause).not.toContain(TOKEN);
  });
});

describe('unit · a run that attached keeps the URL and the exit out of its artifacts', () => {
  test('a page that echoes the connect URL and the proxy password is stored redacted', async () => {
    const captured = capture();
    // The hostile-but-ordinary case: a debug banner, a "your IP / your session" page, a site that
    // prints the request it saw.
    const launcher = fakeCdpLauncher({
      url: 'https://shop.test/',
      html: `<p>connected via ${CDP_URL}</p><p>proxy auth pr0xy-p4ssw0rd</p><p>token ${TOKEN}</p>`,
    });
    await runScrape(
      define({
        egress: () => EXIT,
        artifacts: { storage: () => captured.storage },
        driver: remoteBrowser({
          launcher,
          cdpUrl: () => Promise.resolve({ cdpUrl: CDP_URL }),
        }),
        run: () => Promise.reject(new Error('the body failed after attaching')),
      }),
      captured.args,
    ).catch(() => undefined);
    const stored = [...captured.artifacts.values()].join('\n');
    expect(captured.artifacts.size).toBe(1);
    expect(stored).toContain('[redacted]');
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain('pr0xy-p4ssw0rd');
    expect(captured.lines.join('\n')).not.toContain(TOKEN);
    expect(captured.lines.join('\n')).not.toContain('pr0xy-p4ssw0rd');
  });

  test('an OFFLINE driver never parses the exit, and its password is still redacted', async () => {
    // The run conceals the exit itself: a recorded or third-party driver is handed `init.proxy`
    // and may do nothing with it at all.
    const captured = capture();
    await runScrape(
      define({
        egress: () => EXIT,
        artifacts: { storage: () => captured.storage },
        driver: fakeBrowser([
          { url: 'https://shop.test/', html: '<p>proxy-authorization pr0xy-p4ssw0rd</p>' },
        ]),
        run: async ({ page }) => {
          await page.goto('https://shop.test/');
          return expect.unreachable('this body fails on purpose, after the page loaded');
        },
      }),
      captured.args,
    ).catch(() => undefined);
    expect([...captured.artifacts.values()].join('\n')).toBe(
      '<p>proxy-authorization [redacted]</p>',
    );
  });

  test('a prompt answer typed into a page that echoes it is redacted in the artifact', async () => {
    const captured = capture();
    const launcher = fakeCdpLauncher({
      url: 'https://shop.test/',
      html: '<p>you entered 482913</p>',
    });
    await runScrape(
      define({
        artifacts: { storage: () => captured.storage },
        driver: remoteBrowser({ launcher, cdpUrl: 'ws://browser.test/1' }),
        prompt: () => '482913',
        auth: {
          login: async ({ prompt }) => {
            await prompt('sms code');
          },
        },
        run: () => Promise.reject(new Error('the body failed after the login')),
      }),
      captured.args,
    ).catch(() => undefined);
    const stored = [...captured.artifacts.values()].join('\n');
    expect(stored).toBe('<p>you entered [redacted]</p>');
  });
});

describe('unit · what a credential-bearing URL may say, and what it hands the secret set', () => {
  test('endpointLabel is scheme and host — no userinfo, no path, no query', () => {
    expect(endpointLabel(CDP_URL)).toBe('wss://connect.provider.test:8443');
    expect(endpointLabel(EXIT)).toBe('http://exit-7.test:8080');
    expect(endpointLabel('not a url')).toBe('an endpoint that is not a URL');
  });

  test('urlSecretValues covers the whole URL, the path with its query, the token and the password', () => {
    const values = urlSecretValues(CDP_URL);
    expect(values).toContain(CDP_URL);
    expect(values).toContain(`/chrome?token=${TOKEN}&region=eu`);
    expect(values).toContain(TOKEN);
    expect(urlSecretValues(EXIT)).toContain('pr0xy-p4ssw0rd');
    // The username is an account and a zone; redacting it by value would blank ordinary words.
    expect(urlSecretValues(EXIT)).not.toContain('zone-res');
    expect(urlSecretValues('not a url')).toEqual(['not a url']);
  });

  test('a percent-encoded password is concealed in both spellings, and a lone % does not throw', () => {
    expect(urlSecretValues('http://u:p%40ss%3Aword@exit.test')).toEqual(
      expect.arrayContaining(['p%40ss%3Aword', 'p@ss:word']),
    );
    expect(() => urlSecretValues('http://u:100%@exit.test')).not.toThrow();
  });
});
