// The push half of the `pwa` block: `push: true` with a `vapid` needs a subject a push service
// accepts (with no `vapid` it boots unwired, as 26.0.0 did), a `vapid` with no `push` is a key
// nothing reads, and both refusals carry the push remedy — not the install block's. The KEYS are never config (`config-pwa.ts`'s `PwaVapidConfig` says why).

import { describe, expect, test } from 'bun:test';
import type { PwaConfigInput } from './config';
import { defineConfig } from './config';
import { pushWired } from './config-pwa';
import { isUltimateError } from './errors';

const INSTALLABLE = {
  enabled: true,
  name: 'My App',
  offline: { fallback: '/offline' },
  colors: {
    light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
    dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
  },
} as const;

const refusal = (pwa: PwaConfigInput): { cause: string; fix: string; code: string } => {
  try {
    defineConfig({ name: 'myapp', pwa });
  } catch (error) {
    if (isUltimateError(error)) return { cause: error.cause, fix: error.fix, code: error.code };
    throw error;
  }
  return expect.unreachable('the config was accepted');
};

describe('defineConfig · pwa.push and pwa.vapid', () => {
  test('push with a mailto: or https: subject is accepted and resolved', () => {
    for (const subject of ['mailto:ops@example.com', 'https://example.com/contact']) {
      const config = defineConfig({
        name: 'myapp',
        pwa: { ...INSTALLABLE, push: true, vapid: { subject } },
      });
      expect(config.pwa.vapid).toEqual({ subject });
    }
  });

  test('push with no vapid still boots, as on 26.0.0 — and wires nothing (27.0.0 refuses it)', () => {
    const config = defineConfig({ name: 'myapp', pwa: { ...INSTALLABLE, push: true } });
    expect(config.pwa.push).toBe(true);
    expect(pushWired(config.pwa)).toBe(false);
    const wired = defineConfig({
      name: 'myapp',
      pwa: { ...INSTALLABLE, push: true, vapid: { subject: 'mailto:ops@example.com' } },
    });
    expect(pushWired(wired.pwa)).toBe(true);
  });

  test('a vapid block whose subject is missing is refused, naming the key and the push remedy', () => {
    const { code, cause, fix } = refusal({
      ...INSTALLABLE,
      push: true,
      vapid: {} as unknown as { subject: string },
    });
    expect(code).toBe('X_CONFIG_INVALID');
    expect(cause).toContain('pwa.vapid.subject is required when pwa.push is true');
    expect(fix).toContain("vapid: { subject: 'mailto:");
    expect(fix).toContain('x vapid create');
    // The install remedy rides only on an install finding.
    expect(fix).not.toContain('a browser paints the install splash');
  });

  test('a subject a push service refuses is refused here: bare address, http:, garbage', () => {
    for (const subject of ['ops@example.com', 'http://example.com', 'mailto:', '']) {
      expect(refusal({ ...INSTALLABLE, push: true, vapid: { subject } }).cause).toContain(
        'must be a mailto: address or an https: URL',
      );
    }
  });

  test('vapid without push is a key with no reader, and is refused', () => {
    expect(
      refusal({ ...INSTALLABLE, push: false, vapid: { subject: 'mailto:ops@example.com' } }).cause,
    ).toContain('pwa.vapid is set while pwa.push is false');
  });

  test('a key the vapid section does not hold is refused by path, keys never live in config', () => {
    const { cause } = refusal({
      ...INSTALLABLE,
      push: true,
      vapid: { subject: 'mailto:ops@example.com', publicKey: 'B…' } as unknown as {
        subject: string;
      },
    });
    expect(cause).toContain('pwa.vapid.publicKey');
  });

  test('a disabled block asks nothing of push — there is no worker to carry a handler', () => {
    expect(defineConfig({ name: 'myapp', pwa: { push: true } }).pwa.push).toBe(true);
  });
});
