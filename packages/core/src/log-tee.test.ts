// `addLogSink`: a tee beside the process's streams, never instead of them — the line a sink sees is
// the one stdout gets, already redacted, and a sink that throws or logs cannot cost the line.

import { afterEach, describe, expect, test } from 'bun:test';
import { InternalError } from './errors';
import { addLogSink, logTeeCount } from './log-tee';
import type { LogLevel } from './logger';
import { logger, REDACTED, setLogSink, structuredLogger } from './logger';

const removers: (() => void)[] = [];
const added = (sink: (line: string, level: LogLevel) => void): (() => void) => {
  const remove = addLogSink(sink);
  removers.push(remove);
  return remove;
};

/** The process streams, stood in for by the test seam — what a tee must NOT replace. */
function streams(): { readonly lines: string[]; restore(): void } {
  const lines: string[] = [];
  const previous = setLogSink((line) => lines.push(line));
  return { lines, restore: () => setLogSink(previous) };
}

afterEach(() => {
  for (const remove of removers.splice(0)) remove();
});

describe('unit · addLogSink tees every default-writer line', () => {
  test('the sink and the streams both get the same line, at its level', () => {
    const out = streams();
    try {
      const teed: [LogLevel, string][] = [];
      added((line, level) => teed.push([level, line]));
      logger.warn('tee.line', { n: 1 });
      expect(out.lines).toHaveLength(1);
      expect(teed).toEqual([['warn', out.lines[0] as string]]);
    } finally {
      out.restore();
    }
  });

  test('the teed line is the redacted one', () => {
    const out = streams();
    try {
      const teed: string[] = [];
      added((line) => teed.push(line));
      logger.info('tee.secret', { password: 'hunter2' });
      expect(teed[0]).toContain(REDACTED);
      expect(teed[0]).not.toContain('hunter2');
    } finally {
      out.restore();
    }
  });

  test('a child logger reaches the sink; a logger with its own writer does not', () => {
    const out = streams();
    try {
      const teed: string[] = [];
      added((line) => teed.push(line));
      logger.child({ jobId: 'j1' }).info('tee.child');
      structuredLogger({ writer: () => undefined }).info('tee.own-writer');
      expect(teed).toHaveLength(1);
      expect(JSON.parse(teed[0] as string)).toMatchObject({ msg: 'tee.child', jobId: 'j1' });
    } finally {
      out.restore();
    }
  });

  test('unsubscribe stops the tee, is idempotent, and leaves the others', () => {
    const out = streams();
    try {
      const first: string[] = [];
      const second: string[] = [];
      const remove = added((line) => first.push(line));
      added((line) => second.push(line));
      remove();
      remove();
      logger.info('tee.after-remove');
      expect(first).toEqual([]);
      expect(second).toHaveLength(1);
      expect(out.lines).toHaveLength(1);
    } finally {
      out.restore();
    }
  });

  test('a sink that throws costs neither the line nor the sinks after it, and says so once', () => {
    const out = streams();
    try {
      const after: string[] = [];
      added(() => {
        throw new InternalError({ cause: 'sink down', fix: 'x doctor --json' });
      });
      added((line) => after.push(line));
      logger.info('tee.one');
      logger.info('tee.two');
      expect(after).toHaveLength(2);
      const failures = out.lines.filter((line) => line.includes('log.sink_failed'));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('sink down');
      // The two lines themselves still reached the streams.
      expect(out.lines.filter((line) => line.includes('"tee.'))).toHaveLength(2);
    } finally {
      out.restore();
    }
  });

  test('a sink that logs is not re-entered: its own line reaches the streams, not the tee', () => {
    const out = streams();
    try {
      let calls = 0;
      added(() => {
        calls += 1;
        logger.info('tee.from-inside-sink');
      });
      logger.info('tee.outer');
      expect(calls).toBe(1);
      expect(out.lines.some((line) => line.includes('tee.from-inside-sink'))).toBe(true);
    } finally {
      out.restore();
    }
  });

  test('a sink added during a line is not called for that line', () => {
    const out = streams();
    try {
      const late: string[] = [];
      added(() => {
        if (late.length === 0 && logTeeCount() === 1) added((line) => late.push(line));
      });
      logger.info('tee.first');
      expect(late).toEqual([]);
      logger.info('tee.second');
      expect(late).toHaveLength(1);
    } finally {
      out.restore();
    }
  });
});
