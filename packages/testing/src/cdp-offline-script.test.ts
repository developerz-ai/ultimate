import { describe, expect, test } from 'bun:test';
import { offlineScripts } from './cdp-offline-script';

// Row aa: `offline(true)` twice registered the script twice and kept one id, so `online()` removed
// one copy and every new page still read `navigator.onLine === false`.
describe('unit · the offline script is registered at most once per session', () => {
  test('a second add is a no-op, so one remove takes the only registration back', async () => {
    const sent: string[] = [];
    let next = 0;
    const scripts = offlineScripts(async (method, params) => {
      sent.push(`${method} ${String(params['identifier'] ?? '')}`.trim());
      next += 1;
      return { result: { identifier: String(next) } };
    });
    await scripts.add('s1');
    await scripts.add('s1');
    await scripts.remove('s1');
    expect(sent).toEqual([
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.removeScriptToEvaluateOnNewDocument 1',
      'Runtime.evaluate',
    ]);
  });
});
