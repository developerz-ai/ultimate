import { expect, test } from 'bun:test';
import { stepLine, stepStream } from './verify-progress';

test('one finished step is one line of JSON: the step, its verdict, its milliseconds', () => {
  const line = stepLine({ name: 'lint', ok: true, durationMs: 21_987, findings: [] });
  expect(line).not.toContain('\n');
  expect(JSON.parse(line)).toEqual({ step: 'lint', ok: true, ms: 21_987 });
});

test('a step that did not apply says so, and a red one is ok:false', () => {
  expect(
    JSON.parse(stepLine({ name: 'e2e', ok: true, durationMs: 0, skipped: true, findings: [] })),
  ).toEqual({ step: 'e2e', ok: true, ms: 0, skipped: true });
  expect(
    JSON.parse(stepLine({ name: 'unit', ok: false, durationMs: 9, skipped: false, findings: [] })),
  ).toEqual({ step: 'unit', ok: false, ms: 9 });
});

test('stepStream: under --json every finished step is written once; otherwise there is no listener', () => {
  const written: string[] = [];
  const stream = stepStream(true, (line) => written.push(line));
  stream.onStep?.({ name: 'lint', ok: true, durationMs: 5, findings: [] });
  stream.onStep?.({ name: 'unit', ok: false, durationMs: 9, findings: [] });
  expect(written.map((line) => JSON.parse(line).step)).toEqual(['lint', 'unit']);
  expect(stepStream(false, (line) => written.push(line))).toEqual({});
});
