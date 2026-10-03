// `@ultimat3/ui`'s centred overlays under `dir="rtl"` on a 390px phone, in a real Chrome. A logical
// inset beside a physical -50% translate is right in LTR and a whole width off in RTL — the command
// palette sat almost entirely off-screen. `rtl-sheets.test.ts` in ui refuses the pattern in source;
// this is the layout a browser actually computes. Skips with no Chrome, unless E2E_BROWSER_REQUIRED=1.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { findChrome } from '@ultimat3/testing';
import type { ShotClock, ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';

const UI = join(import.meta.dir, '..', '..', 'ui', 'src');
const VIEWPORT = { width: 390, height: 700 } as const;

interface SassApi {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}

/** `sass` is `@ultimat3/render`'s dependency, resolved from its directory — never a second copy. */
const sass = (await import(
  Bun.resolveSync('sass', join(import.meta.dir, '..', '..', 'render'))
)) as SassApi;

/** A ui sheet as Sass emits it — class names unscoped, which is all the fixture markup needs. */
const compiled = async (relative: string): Promise<string> => {
  const path = join(UI, relative);
  return sass.compileString(await Bun.file(path).text(), { url: new URL(`file://${path}`) }).css;
};

const SHEETS = [
  'tokens/theme.scss',
  'tokens/reset.scss',
  'components/CommandPalette.module.scss',
  'components/Tooltip.module.scss',
  'components/Popover.module.scss',
];

// Each anchor sits off-centre on purpose: centring that only works when the anchor is in the middle
// of the page is not centring on the anchor.
const BODY = `
<div style="padding-block: 120px; padding-inline: 40px">
  <span class="wrap" id="tip-anchor" style="margin-inline-start: 150px">
    <button type="button">Trigger</button>
    <span class="bubble placement-block-end" id="tip">A tooltip that is wider than its trigger</span>
  </span>
</div>
<div style="padding-inline: 40px">
  <div class="anchor" id="pop-anchor" style="margin-inline-start: 150px">
    <button type="button">Open</button>
    <div class="panel placement-block-end align-center" id="pop">Centred popover content</div>
  </div>
</div>
<div style="padding-block: 40px; padding-inline: 40px">
  <div class="anchor" id="side-anchor" style="margin-inline-start: 150px">
    <button type="button">Side</button>
    <div class="panel placement-inline-end align-start" id="side">Beside the anchor</div>
  </div>
</div>
<dialog class="palette" open id="palette"><div class="panel">Palette</div></dialog>`;

const clock: ShotClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

interface Box {
  readonly left: number;
  readonly right: number;
}

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';

describe.skipIf(chrome === undefined && !required)('ui overlays under dir="rtl" at 390px', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  let boxes: Readonly<Record<string, Box>> = {};

  beforeAll(async () => {
    const css = (await Promise.all(SHEETS.map(compiled))).join('\n');
    const document = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><style>${css}</style></head><body>${BODY}</body></html>`;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(document, { headers: { 'content-type': 'text/html' } }),
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    const driver = cdpShotDriver({ executablePath: chrome, viewport: VIEWPORT });
    session = await driver.open({
      name: 'ui rtl',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: 20_000,
    });
    await session.page.goto(`http://localhost:${String(server.port)}/`);
    await session.page.waitFor('#palette', { state: 'attached' });
    const measured = await session.page.evaluate(`JSON.stringify(Object.fromEntries(
      ['tip-anchor', 'tip', 'pop-anchor', 'pop', 'side-anchor', 'side', 'palette'].map((id) => {
        const box = document.getElementById(id).getBoundingClientRect();
        return [id, { left: box.left, right: box.right }];
      })))`);
    boxes = JSON.parse(String(measured)) as Record<string, Box>;
  }, 60_000);

  // THE close: the connection, the Chrome process and its profile directory.
  afterAll(async () => {
    await session?.close();
    server?.stop(true);
  });

  const box = (id: string): Box => boxes[id] ?? expect.unreachable(`no box measured for #${id}`);
  const centre = (of: Box): number => (of.left + of.right) / 2;

  test('the command palette sits inside the viewport', () => {
    expect(box('palette').left).toBeGreaterThanOrEqual(0);
    expect(box('palette').right).toBeLessThanOrEqual(VIEWPORT.width);
  });

  test('the tooltip centres on its anchor', () => {
    expect(Math.abs(centre(box('tip')) - centre(box('tip-anchor')))).toBeLessThanOrEqual(1);
  });

  test('a centre-aligned popover centres on its anchor', () => {
    expect(Math.abs(centre(box('pop')) - centre(box('pop-anchor')))).toBeLessThanOrEqual(1);
  });

  test('an inline-end popover sits beside its anchor — on the left, in RTL — never over it', () => {
    expect(box('side').right).toBeLessThanOrEqual(box('side-anchor').left);
  });
});
