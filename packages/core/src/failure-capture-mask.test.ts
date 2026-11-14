// Single responsibility: pins what a failure bundle keeps — a key declared secret is masked and
// listed, and a value an app's `redactValues()` pattern matches never survives into the bundle.

import { expect, test } from 'bun:test';
import { captureValue } from './failure-capture-mask';
import { REDACTED, redactValues } from './logger';

test('a credential key is masked and its path listed', () => {
  const captured = captureValue({ card: { password: 'hunter2' }, note: 'ok' });
  expect(captured.value).toEqual({ card: { password: REDACTED }, note: 'ok' });
  expect(captured.masked).toEqual(['card.password']);
});

test('a registered value pattern never survives into a captured bundle, at any depth', () => {
  redactValues([{ pattern: /rvcap_[0-9]{6}/g, replace: '[acct]' }]);
  const captured = captureValue({
    note: 'pay rvcap_123456 then rvcap_654321',
    items: [{ ref: 'rvcap_000111' }],
    top: 'rvcap_999999',
  });
  expect(JSON.stringify(captured.value)).not.toMatch(/rvcap_[0-9]{6}/);
  expect(captured.value).toEqual({
    note: 'pay [acct] then [acct]',
    items: [{ ref: '[acct]' }],
    top: '[acct]',
  });
  expect(captureValue('rvcap_424242').value).toBe('[acct]');
});
