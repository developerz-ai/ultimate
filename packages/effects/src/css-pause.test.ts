import { describe, expect, test } from 'bun:test';
import type { EffectBackend } from './backend';
import { mountCssPause } from './css-pause';
import { asElement, FakeHost, FakeRoot } from './fake-host-fixture';

const rig = (allowed = true) => {
  const host = new FakeHost();
  host.allowedNow = allowed;
  const root = new FakeRoot();
  const labels: EffectBackend[] = [];
  const stop = mountCssPause(
    asElement(root),
    {
      observeVisible: host.observeVisible,
      allowed: host.motion.allowed,
      onChange: host.motion.onChange,
    },
    (b) => labels.push(b),
  );
  return { host, root, labels, stop };
};

describe('unit · CSS pause', () => {
  test('labels css, and static under reduced motion or a user pause', () => {
    const r = rig();
    expect(r.labels).toEqual(['css']);
    r.host.setMotion(false);
    expect(r.labels.at(-1)).toBe('static');
    expect(rig(false).labels).toEqual(['static']);
  });

  test('offscreen or a hidden tab writes data-effect-paused; back on screen clears it', () => {
    const r = rig();
    r.host.setVisible(false);
    expect(r.root.getAttribute('data-effect-paused')).toBe('');
    r.host.setVisible(true);
    expect(r.root.getAttribute('data-effect-paused')).toBeNull();
  });

  test('the answer stops both watches', () => {
    const r = rig();
    r.stop();
    expect(r.host.live()).toBe(0);
  });
});
