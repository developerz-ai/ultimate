// An outage is one fact: said on failures 1, 2, 4, 8, …, at the level its owner chose, and once
// more when it ends — never once per retry.

import { afterEach, describe, expect, test } from 'bun:test';
import { type LogLevel, setLogSink } from './logger';
import { isOutageMilestone, outageLog } from './outage-log';

interface Line {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function capture(): Line[] {
  const lines: Line[] = [];
  const previous = setLogSink((line, level) => {
    const { msg, ...fields } = JSON.parse(line) as { msg: string } & Record<string, unknown>;
    lines.push({ level, msg, fields });
  });
  restore = () => setLogSink(previous);
  return lines;
}

describe('outageLog', () => {
  test('a milestone is 1, 2, 4, 8, … and nothing else', () => {
    const said = Array.from({ length: 20 }, (_, index) => index).filter(isOutageMilestone);
    expect(said).toEqual([1, 2, 4, 8, 16]);
  });

  test('100 failures are 7 lines at the chosen level, each carrying the count', () => {
    const lines = capture();
    const outage = outageLog({ event: 'bus.away', level: 'warn' });
    const said: boolean[] = [];
    for (let failure = 0; failure < 100; failure += 1) said.push(outage.failed({ topic: 'room' }));
    expect(lines.map((line) => [line.level, line.msg, line.fields['failures']])).toEqual(
      [1, 2, 4, 8, 16, 32, 64].map((failures) => ['warn', 'bus.away', failures]),
    );
    expect(lines[0]?.fields['topic']).toBe('room');
    expect(said.filter(Boolean)).toHaveLength(7);
    expect(outage.failures).toBe(100);
  });

  test('`error` is written at error', () => {
    const lines = capture();
    outageLog({ event: 'sync.bus_away', level: 'error' }).failed();
    expect(lines.map((line) => line.level)).toEqual(['error']);
  });

  test('recovery is ONE info line with the count, and the next outage starts at 1 again', () => {
    const lines = capture();
    const outage = outageLog({ event: 'bus.away', level: 'error' });
    for (let failure = 0; failure < 5; failure += 1) outage.failed();
    outage.recovered({ bus: 'nats' });
    outage.recovered();
    expect(lines.slice(3)).toEqual([
      {
        level: 'info',
        msg: 'bus.away recovered',
        fields: expect.objectContaining({ after: 5, bus: 'nats' }),
      },
    ]);
    expect(outage.failures).toBe(0);
    expect(outage.failed()).toBe(true);
    expect(lines.at(-1)?.fields['failures']).toBe(1);
  });

  test('a recovery with nothing failed says nothing', () => {
    const lines = capture();
    outageLog({ event: 'bus.away', level: 'warn' }).recovered();
    expect(lines).toEqual([]);
  });
});
