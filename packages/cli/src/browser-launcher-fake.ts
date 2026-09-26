// `fakeShotDriver`: a `ShotDriver` over recorded pages, so every `x shot` and `ui.*` test runs with
// no Chrome. It parses markup and runs none of it — `query()` is answered from the HTML,
// `evaluate()` from a recorded table, and a click follows `data-goto` or an `<a href>`. What it
// cannot know it refuses by name rather than inventing: no layout box, and no accessibility tree.
import { hostDecision, notImplemented } from '@ultimat3/core';
import { CdpCallFailedError } from '@ultimat3/testing';
import { queryHtml } from './browser-launcher-fake-html';
import type {
  CaptureClip,
  ElementSnapshot,
  NetworkEntry,
  ShotColorScheme,
  ShotDriver,
  ShotPage,
  ShotSession,
  ShotSessionInit,
} from './browser-launcher-port';
import { awaitReady } from './cdp-shot-element';
import { ShotHostRefusedError } from './cdp-shot-errors';
import { parseKeyChord } from './cdp-shot-keys';

export const FAKE_SHOT_DRIVER = 'fake';

/** One recorded page: its url, its markup, and `expression -> JSON text` for `evaluate()`. */
export interface FakeShotPage {
  readonly url: string;
  readonly html: string;
  readonly evaluate?: Readonly<Record<string, string>> | undefined;
  /** The document's HTTP status. Absent is 200 — the page was recorded because it exists. */
  readonly status?: number | undefined;
}

/** A PNG signature, and nothing behind it: deterministic bytes, never a render. */
export const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Different deterministic bytes for every framing fact that was set — one per rectangle, one per
 * colour preference — so a caller that dropped the clip or the scheme fails a test here, which is
 * the only place a framing knob can be proved without a browser (issue #338).
 */
export const framedPng = (clip: CaptureClip | undefined, scheme: ShotColorScheme): Uint8Array => {
  const notes =
    (clip === undefined
      ? ''
      : ` clip ${String(clip.x)},${String(clip.y)},${String(clip.width)},${String(clip.height)}`) +
    (scheme === 'no-preference' ? '' : ` scheme ${scheme}`);
  if (notes === '') return FAKE_PNG;
  const suffix = new TextEncoder().encode(notes);
  const out = new Uint8Array(FAKE_PNG.length + suffix.length);
  out.set(FAKE_PNG);
  out.set(suffix, FAKE_PNG.length);
  return out;
};

const normalise = (url: string): string => {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
};

function fakePage(byUrl: ReadonlyMap<string, FakeShotPage>, init: ShotSessionInit): ShotPage {
  let current: FakeShotPage | undefined;
  let scheme: ShotColorScheme = 'no-preference';
  const network: NetworkEntry[] = [];
  const url = (): string => current?.url ?? 'about:blank';

  const navigate = (to: string): void => {
    const page = byUrl.get(normalise(to));
    if (page === undefined) {
      throw new CdpCallFailedError({
        method: `Page.navigate to ${to}`,
        detail: 'fakeShotDriver() has no page recorded at that url',
      });
    }
    current = page;
    network.push({
      method: 'GET',
      url: page.url,
      // Data the page answers with, never a bound — a recorded page exists, so absent is a 200.
      status: page.status === undefined ? 200 : page.status,
      resourceType: 'document',
      at: init.clock.now().getTime(),
    });
  };

  const query = (selector: string): Promise<readonly ElementSnapshot[]> =>
    queryHtml(current?.html ?? '', selector);

  const ready = (selector: string, options?: Parameters<ShotPage['waitFor']>[1]) =>
    awaitReady({
      selector,
      state: options?.state ?? 'actionable',
      timeoutMs: options?.timeout ?? init.timeoutMs,
      clock: init.clock,
      url,
      snapshot: async () => (await query(selector))[0],
    });

  return {
    url,
    async goto(to) {
      if (!hostDecision(to, init.rules.allowHosts).allowed) {
        throw new ShotHostRefusedError({ url: to, allowHosts: init.rules.allowHosts });
      }
      navigate(to);
    },
    waitFor: (selector, options) => ready(selector, options),
    async click(selector, options) {
      const target = await ready(selector, options);
      // What the browser would do with the click, as far as markup can say: follow the link.
      const next =
        target.attrs['data-goto'] ?? (target.tag === 'a' ? target.attrs['href'] : undefined);
      if (next !== undefined) navigate(new URL(next, url()).toString());
    },
    async type(selector, _text, options) {
      await ready(selector, options);
    },
    async focus(selector, options) {
      await ready(selector, options);
    },
    async press(chord) {
      parseKeyChord(chord);
    },
    async accessibility() {
      return notImplemented(
        'accessibility() on fakeShotDriver()',
        'assert on the markup with page.query(selector) — a role read off the HTML would hide the element a screen reader cannot name, which is the finding this read exists for',
      );
    },
    query,
    async evaluate(expression) {
      const table = current?.evaluate ?? {};
      const recorded = Object.hasOwn(table, expression) ? table[expression] : undefined;
      if (recorded === undefined) {
        throw new CdpCallFailedError({
          method: 'Runtime.evaluate',
          detail: 'fakeShotDriver() has no answer recorded for that expression on this page',
        });
      }
      return JSON.parse(recorded) as unknown;
    },
    async screenshot(options) {
      return framedPng(options?.clip, scheme);
    },
    async colorScheme(next) {
      scheme = next;
    },
    async prepare() {},
    console: () => [],
    pageErrors: () => [],
    pageErrorsDropped: () => 0,
    network: () => [...network],
    networkDropped: () => 0,
  };
}

/** A driver whose every session reads from `pages`. An unrecorded url is refused, never fetched. */
export function fakeShotDriver(pages: readonly FakeShotPage[]): ShotDriver {
  const byUrl = new Map(pages.map((page) => [normalise(page.url), page]));
  return {
    name: FAKE_SHOT_DRIVER,
    async open(init): Promise<ShotSession> {
      return { page: fakePage(byUrl, init), close: async () => undefined };
    },
  };
}
