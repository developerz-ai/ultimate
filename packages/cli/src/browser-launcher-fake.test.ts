// The offline driver every `x shot` / `ui.*` test runs on. What it may answer from markup, it does;
// what only a browser knows — a layout box, an accessibility tree — it refuses rather than invents.
import { describe, expect, test } from 'bun:test';
import { fakeShotDriver } from './browser-launcher-fake';
import { systemShotClock } from './cdp-shot-clock';

const HTML =
  '<main><a id="go" href="/next">Next</a><button id="off" disabled>Off</button>' +
  '<p id="gone" hidden>gone</p><input id="pw" type="password" value="x"></main>';

const open = () =>
  fakeShotDriver([
    { url: 'http://localhost:1/', html: HTML, evaluate: { 'document.title': '"Home"' } },
    { url: 'http://localhost:1/next', html: '<h1>Next</h1>' },
  ]).open({
    name: 'x shot',
    rules: { allowHosts: ['localhost'] },
    clock: systemShotClock,
    timeoutMs: 200,
  });

describe('unit · fakeShotDriver answers from markup', () => {
  test('query reads attributes, visibility and enablement off the HTML, with no box', async () => {
    const { page } = await open();
    await page.goto('http://localhost:1/');
    const [pw] = await page.query('#pw');
    expect(pw?.attrs['type']).toBe('password');
    expect(pw?.box).toBeUndefined();
    expect((await page.query('#gone'))[0]?.visible).toBe(false);
    expect((await page.query('#off'))[0]?.enabled).toBe(false);
  });

  test('a click on a link follows it, and evaluate answers only what was recorded', async () => {
    const { page } = await open();
    await page.goto('http://localhost:1/');
    expect(await page.evaluate('document.title')).toBe('Home');
    expect(await page.evaluate('location.href').catch((e: unknown) => e)).toBeUltimateError(
      'X_CDP_CALL_FAILED',
    );
    await page.click('#go');
    expect(page.url()).toBe('http://localhost:1/next');
  });

  test('a disabled element never becomes actionable, and accessibility is refused', async () => {
    const { page } = await open();
    await page.goto('http://localhost:1/');
    expect(await page.click('#off').catch((e: unknown) => e)).toBeUltimateError(
      'X_SHOT_ELEMENT_UNREADY',
    );
    expect(await page.accessibility('a').catch((e: unknown) => e)).toBeUltimateError(
      'X_NOT_IMPLEMENTED',
    );
  });

  test('a goto off the allow list is refused as the real driver refuses it', async () => {
    const { page } = await open();
    expect(await page.goto('http://evil.test/').catch((e: unknown) => e)).toBeUltimateError(
      'X_SHOT_HOST_REFUSED',
    );
  });
});
