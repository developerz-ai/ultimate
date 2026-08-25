// What a recording may legitimately be EMPTY. `t.string` refuses `''`, so a 204, a blank header,
// a blank page and a blank frame were all `X_VALIDATION_FAILED` — and `fakeBrowser()` builds
// recordings directly and never parses, so the two offline drivers disagreed about the same file.

import { describe, expect, test } from 'bun:test';
import { parseHttpRecording, parseRecording, splitDownload } from './recording';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · an empty string is a real recorded answer', () => {
  test('a page recorded with no markup parses — a blank document is a document', () => {
    expect(parseRecording({ url: 'https://shop.test/o', html: '' }).html).toBe('');
  });

  test('a frame recorded with no markup parses — an empty iframe is what many sites serve', () => {
    const recording = parseRecording({
      url: 'https://shop.test/o',
      html: '<iframe name="f"></iframe>',
      frames: { f: '' },
    });
    expect(recording.frames?.['f']).toBe('');
  });

  test('a 204 replays: no body is the whole point of the status', () => {
    const recording = parseHttpRecording({
      url: 'https://shop.test/api/like',
      method: 'POST',
      status: 204,
      body: '',
    });
    expect(recording.status).toBe(204);
    expect(recording.body).toBe('');
  });

  test('a header the site sent empty replays as empty, not as a refusal', () => {
    const recording = parseHttpRecording({
      url: 'https://shop.test/api/o',
      method: 'GET',
      status: 200,
      body: '{}',
      headers: { 'x-trace': '' },
    });
    expect(recording.headers?.['x-trace']).toBe('');
  });
});

describe('unit · what stays non-empty, because empty could not be an answer', () => {
  test('a recording with no url is refused — there is nothing to key it by', () => {
    expect(codeOf(() => parseRecording({ url: '', html: '<p>o</p>' }))).toBe('X_VALIDATION_FAILED');
  });

  test('an evaluate recorded as "" is refused — the value is JSON text, and "" is not JSON', () => {
    // `htmlTarget` answers `JSON.parse(recorded)`, so an empty value throws a bare `SyntaxError`
    // at read time rather than a coded refusal at load time. Refusing here is the earlier answer.
    expect(
      codeOf(() => parseRecording({ url: 'https://a.test/', html: '', evaluate: { x: '' } })),
    ).toBe('X_VALIDATION_FAILED');
  });

  test('an http recording with no method is refused', () => {
    expect(
      codeOf(() =>
        parseHttpRecording({ url: 'https://a.test/', method: '', status: 200, body: '{}' }),
      ),
    ).toBe('X_VALIDATION_FAILED');
  });
});

describe('unit · splitDownload', () => {
  test('a value with no colon is all contents and a default name', () => {
    expect(splitDownload('a,b,c')).toEqual({ filename: 'download', contents: 'a,b,c' });
  });

  test('the FIRST colon splits, so a CSV containing one keeps it', () => {
    expect(splitDownload('report.csv:a:b')).toEqual({ filename: 'report.csv', contents: 'a:b' });
  });
});
