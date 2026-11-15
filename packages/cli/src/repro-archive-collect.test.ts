// A request's cause and stack come from its error group's sample, which is the group's LATEST
// failure: they ride in a bundle only when that sample is this subject's own request, never another.

import { describe, expect, test } from 'bun:test';
import { sampleFacts } from './repro-archive-collect';

const SAMPLE = { requestId: 'req-1', cause: 'X_BOOM: the cause', stack: 'at f (a.ts:1:1)' };

describe('sampleFacts', () => {
  test("the group's sample is used when it is this request's own", () => {
    expect(sampleFacts(SAMPLE, 'req-1')).toEqual({
      cause: 'X_BOOM: the cause',
      stack: 'at f (a.ts:1:1)',
    });
  });

  test('another request’s sample, an unknown request id, or no sample: nothing', () => {
    const none = { cause: null, stack: null };
    expect(sampleFacts(SAMPLE, 'req-2')).toEqual(none);
    expect(sampleFacts({ ...SAMPLE, requestId: null }, null)).toEqual(none);
    expect(sampleFacts(undefined, 'req-1')).toEqual(none);
  });
});
