import { describe, expect, test } from 'bun:test';
import type { BeforeInstallPromptEventLike, InstallHost } from './install';
import { createInstallController, iosInstallGuidance, MIN_ENGAGEMENT_MS } from './install';

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

function fakeHost(
  now: () => number,
  userAgent = 'Chrome/130',
): InstallHost & {
  fire(type: string, event: unknown): void;
} {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    userAgent,
    standalone: false,
    now,
    addEventListener(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    fire(type, event) {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
}

function promptEvent(outcome: 'accepted' | 'dismissed'): BeforeInstallPromptEventLike & {
  prevented: boolean;
} {
  return {
    prevented: false,
    preventDefault(): void {
      this.prevented = true;
    },
    prompt: async (): Promise<void> => undefined,
    userChoice: Promise.resolve({ outcome }),
  };
}

describe('createInstallController', () => {
  test('captures beforeinstallprompt and suppresses the browser bar', () => {
    const host = fakeHost(() => 0);
    const controller = createInstallController({ host });
    expect(controller.canInstall()).toBe(false);

    const event = promptEvent('accepted');
    host.fire('beforeinstallprompt', event);

    expect(event.prevented).toBe(true);
    expect(controller.canInstall()).toBe(true);
  });

  test('never prompts on first paint', async () => {
    let now = 0;
    const host = fakeHost(() => now);
    const controller = createInstallController({ host });
    host.fire('beforeinstallprompt', promptEvent('accepted'));

    expect(await controller.prompt()).toBe('too-early');
    now = MIN_ENGAGEMENT_MS + 1;
    expect(await controller.prompt()).toBe('accepted');
    expect(controller.canInstall()).toBe(false);
  });

  test('reports unavailable when the platform never offered a prompt', async () => {
    const controller = createInstallController({ host: fakeHost(() => 1_000_000) });
    expect(await controller.prompt()).toBe('unavailable');
  });
});

describe('iosInstallGuidance', () => {
  test('iOS gets guided steps as i18n keys, other platforms get none', () => {
    expect(iosInstallGuidance(IOS_UA, false)?.stepKeys.length).toBe(2);
    expect(iosInstallGuidance(IOS_UA, true)).toBe(null);
    expect(iosInstallGuidance('Chrome/130', false)).toBe(null);
  });
});
