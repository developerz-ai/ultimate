import { describe, expect, test } from 'bun:test';
import { fakePage } from './driver-fake';
import { runRecovery } from './recover';

const attempt = () => ({
  scrape: 'orders',
  page: fakePage('<p>hi</p>'),
  failure: new Error('selector moved'),
  attempt: 1,
});

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · the recovery seam', () => {
  test('a function hook decides, and both answers are legal', async () => {
    expect(await runRecovery(() => true, attempt())).toBe(true);
    expect(await runRecovery(() => false, attempt())).toBe(false);
  });

  test('a hook that answers something other than a boolean is refused, with its own code', async () => {
    const bad = (() => 'maybe') as unknown as Parameters<typeof runRecovery>[0];
    expect(await codeOf(runRecovery(bad, attempt()))).toBe('X_SCRAPE_RECOVER_REFUSED');
  });
});
