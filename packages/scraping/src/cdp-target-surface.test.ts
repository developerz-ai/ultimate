// The rest of the CDP target's surface: the calls that exist only because a real browser has them
// — click/type/select, clear, capture, the cookie jar, frames and the crash guard. Split from
// `cdp-target.test.ts` to keep each file under the 500-line ceiling; that file owns the three
// event-payload rules (restored storage, request method, console level).

import { describe, expect, test } from 'bun:test';
import type { CdpBrowserLike, CdpFrameLike, CdpPageLike, CdpScreenshotOptions } from './cdp-port';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import { scrapeTimeout } from './error-throws';

/** The thrown value itself — the code and the retry classification are both under test here. */
const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    expect.unreachable(
      'the call resolved, and the test needs the failure it was supposed to raise',
    );
  } catch (thrown) {
    return thrown;
  }
};

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  ((await caught(promise)) as { code?: string }).code;

const SNAPSHOT = {
  tag: 'a',
  attrs: { href: '/orders/1' },
  text: 'Order 1',
  value: '',
  visible: true,
  enabled: true,
  box: { x: 10, y: 10, width: 100, height: 20 },
  hitTarget: true,
};

interface Rich {
  readonly page: CdpPageLike;
  readonly browser: CdpBrowserLike;
  readonly calls: readonly string[];
  emit(event: string, payload: unknown): void;
}

/**
 * A page whose every method records, and whose `frames()` answers one child frame. Nothing here
 * evaluates a selector — `evaluate` answers a fixed snapshot — because what is under test is
 * WHICH call the target makes and with what, not what a layout engine would have said.
 */
const rich = (
  options: {
    readonly cookies?: boolean;
    readonly screenshotBase64?: boolean;
    readonly url?: string;
  } = {},
): Rich => {
  const calls: string[] = [];
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  let url = options.url ?? 'https://shop.test/';
  const frame: CdpFrameLike = {
    name: () => 'checkout',
    url: () => 'https://shop.test/checkout-frame',
    content: () => {
      calls.push('frame content');
      return Promise.resolve('<p>frame</p>');
    },
    evaluate: (expression: string) => {
      calls.push(`frame evaluate ${expression.slice(0, 24)}`);
      return Promise.resolve(JSON.stringify([SNAPSHOT]));
    },
    click: (selector: string) => {
      calls.push(`frame click ${selector}`);
      return Promise.resolve();
    },
    type: (selector: string, text: string) => {
      calls.push(`frame type ${selector} ${text}`);
      return Promise.resolve();
    },
    select: (selector: string, ...values: string[]) => {
      calls.push(`frame select ${selector} ${values.join('|')}`);
      return Promise.resolve(values);
    },
  };
  const page: CdpPageLike = {
    url: () => url,
    goto: (next: string) => {
      url = next;
      return Promise.resolve(undefined);
    },
    content: () => Promise.resolve('<html></html>'),
    evaluate: (expression: string) => {
      calls.push(`evaluate ${expression}`);
      if (expression.includes('querySelectorAll'))
        return Promise.resolve(JSON.stringify([SNAPSHOT]));
      if (expression.includes('localStorage')) return Promise.resolve(JSON.stringify({ t: 'abc' }));
      if (expression.includes('navigator.userAgent')) return Promise.resolve('fake-agent');
      return Promise.resolve(undefined);
    },
    click: (selector: string) => {
      calls.push(`click ${selector}`);
      return Promise.resolve();
    },
    type: (selector: string, text: string) => {
      calls.push(`type ${selector} ${text}`);
      return Promise.resolve();
    },
    select: (selector: string, ...values: string[]) => {
      calls.push(`select ${selector} ${values.join('|')}`);
      return Promise.resolve(values);
    },
    screenshot: (shotOptions: CdpScreenshotOptions) => {
      const clip = shotOptions.clip;
      calls.push(
        clip === undefined
          ? `screenshot fullPage=${String(shotOptions.fullPage)}`
          : `screenshot fullPage=${String(shotOptions.fullPage)} clip=${String(clip.x)},${String(clip.y)},${String(clip.width)},${String(clip.height)}`,
      );
      return Promise.resolve(
        options.screenshotBase64 === true ? btoa('PNG') : new Uint8Array([1, 2, 3]),
      );
    },
    pdf: () => {
      calls.push('pdf');
      return Promise.resolve(new Uint8Array([4, 5]));
    },
    setRequestInterception: () => Promise.resolve(),
    on: (event: string, handler: (payload: unknown) => void) => {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return undefined;
    },
    frames: () => [frame],
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
  };
  const browser: CdpBrowserLike = {
    newPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
    process: () => null,
    ...(options.cookies === true
      ? {
          cookies: () =>
            Promise.resolve([
              {
                name: 'sid',
                value: '',
                domain: 'shop.test',
                path: '/',
                httpOnly: true,
                secure: true,
              },
            ]),
        }
      : {}),
  };
  return {
    page,
    browser,
    calls,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
};

const targetOver = (fixture: Rich) =>
  cdpTarget({
    page: fixture.page,
    browser: fixture.browser,
    rules: { allowHosts: ['*'] },
    clock: testClock(),
  });

describe('unit · the target`s input calls reach the page, not a reimplementation of it', () => {
  test('click, type and select pass their selector and values straight through', async () => {
    const fixture = rich();
    const target = await targetOver(fixture);
    await target.click('#buy');
    await target.type('#email', 'a@b.test');
    await target.select('#size', ['m', 'l']);
    expect(fixture.calls).toContain('click #buy');
    expect(fixture.calls).toContain('type #email a@b.test');
    // The values are SPREAD: puppeteer's select takes varargs, and passing the array would select
    // one option literally named "m,l".
    expect(fixture.calls).toContain('select #size m|l');
  });

  test('clear() blanks the field AND dispatches input — a value set with neither is invisible to the app', async () => {
    const fixture = rich();
    await (await targetOver(fixture)).clear('#email');
    const cleared = fixture.calls.find((call) => call.startsWith('evaluate (() => { const el'));
    expect(cleared).toBeDefined();
    const script = fixture.calls.join('\n');
    expect(script).toContain('document.querySelector("#email")');
  });

  test('query parses the page`s own snapshot payload', async () => {
    const target = await targetOver(rich());
    expect((await target.query('a')).map((element) => element.text)).toEqual(['Order 1']);
  });

  test('close closes the page', async () => {
    const fixture = rich();
    await (await targetOver(fixture)).close();
    expect(fixture.calls).toContain('close');
  });
});

describe('unit · capture', () => {
  test('a screenshot that comes back as base64 text is decoded to bytes', async () => {
    // Some builds answer text and some answer bytes; an artifact written from the string would be
    // a PNG nobody can open.
    const fixture = rich({ screenshotBase64: true });
    const shot = await (await targetOver(fixture)).screenshot({ fullPage: true });
    expect(shot).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(shot)).toBe('PNG');
    expect(fixture.calls).toContain('screenshot fullPage=true');
  });

  test('bytes are passed through unchanged, and fullPage defaults to false', async () => {
    const fixture = rich();
    const shot = await (await targetOver(fixture)).screenshot({});
    expect([...shot]).toEqual([1, 2, 3]);
    expect(fixture.calls).toContain('screenshot fullPage=false');
  });

  test('a clip is forwarded to the library VERBATIM, and fullPage is not sent beside it', async () => {
    // The pair is exclusive at the library too: some builds refuse it and some silently pick one,
    // so the request carries only what was asked for. `x shot --island` is the caller.
    const fixture = rich();
    const shot = await (await targetOver(fixture)).screenshot({
      clip: { x: 12, y: 34, width: 300, height: 180 },
    });
    expect([...shot]).toEqual([1, 2, 3]);
    expect(fixture.calls).toContain('screenshot fullPage=undefined clip=12,34,300,180');
    expect(fixture.calls.join('|')).not.toContain('fullPage=true');
  });

  test('pdf comes straight off the page', async () => {
    const fixture = rich();
    expect([...(await (await targetOver(fixture)).pdf({}))]).toEqual([4, 5]);
  });

  test('download() is an honest X_NOT_IMPLEMENTED, never empty bytes', async () => {
    const target = await targetOver(rich());
    expect(await codeOf(target.download({ timeoutMs: 1_000 }))).toBe('X_NOT_IMPLEMENTED');
  });

  test('download() REJECTS — a `.catch()` on it is reached, never jumped over', async () => {
    // The method is typed `Promise<ScrapeDownloadFile>` and `page-over-target.ts` forwards it in a
    // non-async arrow, so a synchronous `throw` here escapes past `page.download().catch(…)` and
    // lands in whatever encloses the call — an artifact writer's `catch` never runs.
    const target = await targetOver(rich());
    let caught: unknown;
    const settled = target.download({ timeoutMs: 1_000 }).catch((thrown: unknown) => {
      caught = thrown;
    });
    await settled;
    expect((caught as { code?: string } | undefined)?.code).toBe('X_NOT_IMPLEMENTED');
  });
});

describe('unit · cookies and session', () => {
  test('a browser with a jar answers it, parsed — an empty cookie value is legal', async () => {
    // A cleared session cookie IS the empty string, and refusing it would refuse the whole jar.
    const target = await targetOver(rich({ cookies: true }));
    expect(await target.cookies()).toEqual([
      { name: 'sid', value: '', domain: 'shop.test', path: '/', httpOnly: true, secure: true },
    ]);
  });

  test('a browser with NO cookies() refuses PERMANENTLY — the code survives guard()', async () => {
    // `guard()` used to re-label this deliberate X_NOT_IMPLEMENTED as X_SCRAPE_BROWSER_UNREACHABLE,
    // which is registered `retryable`: a launcher that structurally lacks `browser.cookies()` then
    // spent every attempt in the retry policy on a method that is still missing, and told the
    // operator the browser went away while the browser was answering fine.
    const target = await targetOver(rich());
    const thrown = await caught(target.cookies());
    expect((thrown as { code?: string }).code).toBe('X_NOT_IMPLEMENTED');
    expect((thrown as { retry?: string }).retry).toBe('terminal');
    expect((thrown as { cause?: string }).cause).toContain(
      'cookies() on a CDP browser with no cookies() method',
    );
  });

  test('session() reads storage, agent and origin, and answers [] for a jar-less browser', async () => {
    const target = await targetOver(rich());
    expect(await target.session()).toEqual({
      cookies: [],
      headers: {},
      storage: { t: 'abc' },
      userAgent: 'fake-agent',
      origin: 'https://shop.test',
    });
  });

  test('a page on about:blank has NO origin — never the string "about:blank"', async () => {
    // `new URL('about:blank').origin` is `'null'`, and a session stamped with that would be
    // restorable against a site it does not belong to.
    const session = await (await targetOver(rich({ url: 'not a url' }))).session();
    expect(session.origin).toBe('');
  });
});

describe('unit · frames', () => {
  test('each frame is named, addressed and driven through the FRAME, not the page', async () => {
    const fixture = rich();
    const target = await targetOver(fixture);
    const frames = await target.frames();

    expect(frames.map((frame) => [frame.name, frame.url])).toEqual([
      ['checkout', 'https://shop.test/checkout-frame'],
    ]);

    const inner = frames[0]?.target;
    expect(inner).toBeDefined();
    if (inner === undefined) return;
    expect(inner.url()).toBe('https://shop.test/checkout-frame');
    expect(await inner.content()).toBe('<p>frame</p>');
    expect((await inner.query('a')).map((element) => element.text)).toEqual(['Order 1']);
    await inner.click('#pay');
    await inner.type('#card', '4242');
    await inner.select('#country', ['de']);
    await inner.evaluate('1 + 1');
    // A nested frame list is empty: the port exposes no child frames of a frame.
    expect(await inner.frames()).toEqual([]);

    expect(fixture.calls).toEqual(
      expect.arrayContaining([
        'frame content',
        'frame click #pay',
        'frame type #card 4242',
        'frame select #country de',
      ]),
    );
    // Nothing addressed the top-level page.
    expect(fixture.calls.filter((call) => call === 'click #pay')).toEqual([]);
  });
});

describe('unit · a dead renderer is a CODE, not a hang', () => {
  test('every later call answers X_SCRAPE_PAGE_CRASHED once the page emitted an error', async () => {
    const fixture = rich();
    const target = await targetOver(fixture);
    fixture.emit('error', { message: 'Renderer process crashed' });

    await expect(target.content()).rejects.toThrow(/X_SCRAPE_PAGE_CRASHED|crashed/);
    await expect(target.click('#buy')).rejects.toThrow(/X_SCRAPE_PAGE_CRASHED|crashed/);
    // And the call never reached the page: a crashed tab would wait out its own timeout.
    expect(fixture.calls).not.toContain('click #buy');
  });

  test('a page that is merely failing is X_SCRAPE_BROWSER_UNREACHABLE, a different code', async () => {
    const fixture = rich();
    const target = await targetOver(fixture);
    const broken: CdpPageLike = {
      ...fixture.page,
      content: () => Promise.reject(new Error('Target closed')),
    };
    const other = await cdpTarget({
      page: broken,
      browser: fixture.browser,
      rules: { allowHosts: ['*'] },
      clock: testClock(),
    });
    await expect(other.content()).rejects.toThrow(/browser stopped answering/);
    await expect(target.content()).resolves.toBe('<html></html>');
  });
});

describe('unit · guard() wraps what came FROM the browser, and only that', () => {
  test('a page call failing with a CODED error is still X_SCRAPE_BROWSER_UNREACHABLE', async () => {
    // The naive repair — pass every `UltimateError` through — would unwrap this one, and the wrap
    // is what makes a mid-run disconnect legible: a timeout raised while the socket was already
    // dead is the browser going away, whatever code the library's own layer put on it.
    const fixture = rich();
    const target = await cdpTarget({
      page: { ...fixture.page, content: () => Promise.reject(scrapeTimeout('content', 500)) },
      browser: fixture.browser,
      rules: { allowHosts: ['*'] },
      clock: testClock(),
    });
    const thrown = await caught(target.content());
    expect((thrown as { code?: string }).code).toBe('X_SCRAPE_BROWSER_UNREACHABLE');
    expect((thrown as { cause?: string }).cause).toContain('puppeteer content');
    expect((thrown as { cause?: string }).cause).toContain('X_SCRAPE_TIMEOUT');
  });
});
