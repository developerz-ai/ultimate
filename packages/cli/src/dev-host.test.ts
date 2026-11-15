import { describe, expect, test } from 'bun:test';
import { dashboardUrl, devHostFor, dialableUrl } from './dev-host';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const args = (...argv: string[]) => parseArgs(['dev', ...argv], SPECS);

describe('unit · x dev --host: loopback unless the caller types a wider address', () => {
  test('nothing given is loopback — the default never widens', () => {
    expect(devHostFor(args())).toBe('localhost');
  });

  test('an IPv4 literal, an IPv6 literal (bare or bracketed) and the two wildcards bind as typed', () => {
    expect(devHostFor(args('--host', '127.0.0.1'))).toBe('127.0.0.1');
    expect(devHostFor(args('--host', '0.0.0.0'))).toBe('0.0.0.0');
    expect(devHostFor(args('--host', '::'))).toBe('::');
    expect(devHostFor(args('--host', '[::1]'))).toBe('::1');
    expect(devHostFor(args('--host', 'fd00::5'))).toBe('fd00::5');
    expect(devHostFor(args('--host', 'LOCALHOST'))).toBe('localhost');
  });

  test('a hostname, a typo and a port-carrying address are refused at the boundary', () => {
    for (const bad of ['example.com', '10.0.0.256', '0.0.0.0:3000', '', 'local host']) {
      expect(() => devHostFor(args('--host', bad))).toThrow(
        expect.objectContaining({ code: 'X_CLI_BAD_FLAG', fix: 'x dev --host 0.0.0.0' }),
      );
    }
  });
});

describe('unit · the url x dev reports is one this machine can dial', () => {
  test('a wildcard bind is reported through loopback, its port kept', () => {
    expect(dialableUrl('http://0.0.0.0:3000')).toBe('http://localhost:3000');
    expect(dialableUrl('http://[::]:4100')).toBe('http://localhost:4100');
  });

  test('a specific address is reported as itself', () => {
    expect(dialableUrl('http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
    expect(dialableUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(dialableUrl('http://[::1]:3000')).toBe('http://[::1]:3000');
  });
});

describe('unit · /_x is reported only where a loopback client can reach it', () => {
  test('loopback urls carry /_x; a specific non-loopback bind reports none', () => {
    expect(dashboardUrl('http://localhost:3000')).toBe('http://localhost:3000/_x');
    expect(dashboardUrl('http://[::1]:3000')).toBe('http://[::1]:3000/_x');
    expect(dashboardUrl('http://192.168.1.5:3000')).toBeNull();
  });
});
