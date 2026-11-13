// A container boot says where its time went, one `boot.phase` line per phase as it ends. A worker
// that imported every page for an unstamped build id spent 3.7 s between two log lines on
// examples/dummy, and 4–6 s in a deployed adopter, with nothing to say which step it was.

import { afterEach, describe, expect, test } from 'bun:test';
import type { LogFields } from '@ultimat3/core';
import { frozenClock, logger } from '@ultimat3/core';
import { bootTimeline } from './serve-boot-phases';

const printInfo = logger.info;
const lines: { message: string; fields: LogFields | undefined }[] = [];

afterEach(() => {
  logger.info = printInfo;
  lines.length = 0;
});

describe('unit · the boot timeline', () => {
  test('each phase is logged as it ends, with its own milliseconds and the role', () => {
    logger.info = (message, fields) => {
      lines.push({ message, fields });
    };
    const clock = frozenClock();
    const timeline = bootTimeline('worker', clock);
    clock.advance(120);
    timeline.phase('services');
    clock.advance(4_132);
    timeline.phase('build-id');
    expect(lines).toEqual([
      { message: 'boot.phase', fields: { role: 'worker', name: 'services', ms: 120 } },
      { message: 'boot.phase', fields: { role: 'worker', name: 'build-id', ms: 4_132 } },
    ]);
  });

  test('the total is every phase since the timeline started', () => {
    logger.info = () => {};
    const clock = frozenClock();
    const timeline = bootTimeline('web', clock);
    clock.advance(10.4);
    timeline.phase('services');
    clock.advance(20.4);
    timeline.phase('roles');
    expect(timeline.totalMs()).toBe(31);
  });
});
