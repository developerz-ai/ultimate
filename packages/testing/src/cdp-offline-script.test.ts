import { describe, expect, test } from 'bun:test';
import { CdpCallFailedError } from './cdp-errors';
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

// Traced 2026-10-02: a navigation in flight made Chrome answer the removal `Script not found`. The
// throw skipped the restore, so the open document kept `navigator.onLine === false` and nobody heard.
describe('unit · a removal the browser refuses', () => {
  const refusing = (refuse: string) => {
    const sent: string[] = [];
    const scripts = offlineScripts(async (method) => {
      sent.push(method);
      if (method === refuse) throw new CdpCallFailedError({ method, detail: 'Script not found' });
      return { result: { identifier: '1' } };
    });
    return { sent, scripts };
  };
  const refusal = (call: Promise<unknown>): Promise<{ code?: string; cause?: string }> =>
    call.then(
      () => expect.unreachable('the refusal vanished'),
      (error: unknown) => error as { code?: string; cause?: string },
    );

  test('still restores the open document, and then surfaces — coded, naming the session', async () => {
    const { sent, scripts } = refusing('Page.removeScriptToEvaluateOnNewDocument');
    await scripts.add('s1');

    const error = await refusal(scripts.remove('s1'));

    expect(sent).toEqual([
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.removeScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
    ]);
    expect(error.code).toBe('X_CDP_CALL_FAILED');
    expect(error.cause).toContain('s1');
    expect(error.cause).toContain('Script not found');
  });

  test('keeps the registration, so the next online() asks the browser to remove it again', async () => {
    const { sent, scripts } = refusing('Page.removeScriptToEvaluateOnNewDocument');
    await scripts.add('s1');
    await refusal(scripts.remove('s1'));
    sent.length = 0;

    await scripts.add('s1'); // still held: never a second copy
    await refusal(scripts.remove('s1'));

    expect(sent).toEqual(['Page.removeScriptToEvaluateOnNewDocument', 'Runtime.evaluate']);
  });

  test('a restore the page refuses surfaces too, after the script is gone', async () => {
    const { sent, scripts } = refusing('Runtime.evaluate');
    await scripts.add('s1');

    const error = await refusal(scripts.remove('s1'));

    expect(error.code).toBe('X_CDP_CALL_FAILED');
    expect(sent).toContain('Page.removeScriptToEvaluateOnNewDocument');
    // The script WAS removed: nothing is left to take back, so a second remove is a no-op.
    sent.length = 0;
    await scripts.remove('s1');
    expect(sent).toEqual([]);
  });
});
