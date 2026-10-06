// The shot allow list on the BROWSER's session, over the fake wire: a popup is a target the page
// session's `Fetch` never pauses, so the driver attaches the browser target and decides its pauses
// with the same rule. `cdp-shot-popup.e2e.test.ts` drives a real popup in a real Chrome.
import { describe, expect, test } from 'bun:test';
import { cdpShotDriver } from './cdp-shot-driver';
import { attach, fakeWire, init, opened } from './cdp-shot-wire-fixture';

describe('unit · the allow list holds on every target the page opens', () => {
  test('a browser that answers no browser-target session is refused, and the launch is closed', async () => {
    const wire = fakeWire((call) =>
      call.method === 'Target.attachToBrowserTarget' ? {} : attach(call),
    );
    let closed = 0;
    const driver = cdpShotDriver({
      executablePath: '/usr/bin/chrome',
      launch: async () => ({
        connection: wire.connection,
        close: async () => {
          closed += 1;
        },
      }),
    });
    const error = await driver.open(init()).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_CDP_CALL_FAILED');
    expect(closed).toBe(1);
    expect(wire.methods()).not.toContain('Page.navigate');
  });

  // A popup's requests pause on the BROWSER's session only: the page session never sees them.
  test('a pause on the browser session is decided by the same rule and answered on that session', async () => {
    const { page, wire } = await opened();
    wire.emit(
      'Fetch.requestPaused',
      {
        requestId: 'P1',
        networkId: 'PN1',
        resourceType: 'Document',
        request: { url: 'http://127.0.0.1:9/leak', method: 'GET' },
      },
      'B1',
    );
    wire.emit(
      'Fetch.requestPaused',
      { requestId: 'P2', request: { url: 'http://localhost:3000/ok', method: 'GET' } },
      'B1',
    );
    // Somebody else's interception on a shared browser is not this session's to answer.
    wire.emit(
      'Fetch.requestPaused',
      { requestId: 'P3', request: { url: 'http://evil.test/', method: 'GET' } },
      'S9',
    );
    await Bun.sleep(0);
    const answered = wire.calls
      .filter((call) => call.method.startsWith('Fetch.') && call.method !== 'Fetch.enable')
      .map((call) => [call.method, call.params['requestId'], call.sessionId]);
    expect(answered).toEqual([
      ['Fetch.failRequest', 'P1', 'B1'],
      ['Fetch.continueRequest', 'P2', 'B1'],
    ]);
    expect(page.network()).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:9/leak', refused: 'host' }),
    ]);
  });
});
