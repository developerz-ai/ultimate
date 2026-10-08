// The settings island's push line, per outcome — a failed save is the retry wording, not a verdict
// on the browser.
import { describe, expect, test } from 'bun:test';
import { pushStatus } from './push-status';

const LABELS = { pushOn: 'on', pushDenied: 'blocked', pushUnavailable: 'cannot', retry: 'retry' };

describe('unit · the push status line', () => {
  test('each outcome says what happened, and a failure is never blamed on the browser', () => {
    expect(pushStatus({ status: 'subscribed', endpoint: 'https://push.example/1' }, LABELS)).toBe(
      'on',
    );
    expect(pushStatus({ status: 'denied' }, LABELS)).toBe('blocked');
    expect(pushStatus({ status: 'unsupported' }, LABELS)).toBe('cannot');
    expect(pushStatus({ status: 'unconfigured' }, LABELS)).toBe('cannot');
    expect(pushStatus('failed', LABELS)).toBe('retry');
  });
});
