// Which part documents the `verify` job merges after a "re-run failed jobs": each part's newest
// attempt, and never an earlier attempt's copy of the same part. Run 37918316075 attempt 2 merged
// attempt 1's red `unit-1` beside the green rerun, so a fixed run stayed red.

import { describe, expect, test } from 'bun:test';
import { currentAttemptParts } from './ci-attempt-parts';

describe('currentAttemptParts', () => {
  test('one attempt: every part is current', () => {
    const files = ['p/e2e.attempt-1.json', 'p/unit-1.attempt-1.json', 'p/unit-2.attempt-1.json'];
    expect(currentAttemptParts(files)).toEqual({ current: files, superseded: [], unnamed: [] });
  });

  test('a re-run of the failed job: its new document replaces the old one, the rest stay', () => {
    const files = [
      'p/unit-1.attempt-1.json',
      'p/unit-1.attempt-2.json',
      'p/unit-2.attempt-1.json',
      'p/live.attempt-1.json',
    ];
    expect(currentAttemptParts(files)).toEqual({
      current: ['p/live.attempt-1.json', 'p/unit-1.attempt-2.json', 'p/unit-2.attempt-1.json'],
      superseded: ['p/unit-1.attempt-1.json'],
      unnamed: [],
    });
  });

  test('attempts compare as numbers, not text: 10 is newer than 9', () => {
    const files = ['p/unit-1.attempt-9.json', 'p/unit-1.attempt-10.json'];
    expect(currentAttemptParts(files).current).toEqual(['p/unit-1.attempt-10.json']);
  });

  test('a part whose name holds dots and dashes is still one part', () => {
    const files = ['p/a.b-c.attempt-1.json', 'p/a.b-c.attempt-3.json', 'p/a.attempt-2.json'];
    expect(currentAttemptParts(files)).toEqual({
      current: ['p/a.attempt-2.json', 'p/a.b-c.attempt-3.json'],
      superseded: ['p/a.b-c.attempt-1.json'],
      unnamed: [],
    });
  });

  test('a document that names no attempt cannot be ordered, and is reported, never merged', () => {
    const files = ['p/unit-1.json', 'p/unit-1.attempt-0.json', 'p/unit-2.attempt-1.json'];
    expect(currentAttemptParts(files)).toEqual({
      current: ['p/unit-2.attempt-1.json'],
      superseded: [],
      unnamed: ['p/unit-1.attempt-0.json', 'p/unit-1.json'],
    });
  });

  test('a Windows path separates the same way', () => {
    const files = ['C:\\t\\unit-1.attempt-1.json', 'C:\\t\\unit-1.attempt-2.json'];
    expect(currentAttemptParts(files).current).toEqual(['C:\\t\\unit-1.attempt-2.json']);
  });
});
