// `isLoopbackHostname` lets a Host through `x dev`'s `/_x` door, so an address that only routes
// toward 127.0.0.1 through a translator or a relay must not answer as this machine.
import { describe, expect, test } from 'bun:test';
import { isLoopbackHostname } from './loopback-host';

describe('isLoopbackHostname', () => {
  test.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '[::1]',
    '[::ffff:7f00:1]',
  ])('%s is this machine', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  test.each([
    '[64:ff9b::7f00:1]',
    '[2002:7f00:1::]',
    '[::7f00:1]',
    '[::ffff:0:7f00:1]',
    'evil.test',
    'localhost.evil.test',
    '10.0.0.1',
  ])('%s is not', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });
});
